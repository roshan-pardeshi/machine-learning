import os
import uuid
from datetime import datetime

import numpy as np
import pandas as pd
from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_file,
)
from werkzeug.utils import secure_filename


# ------------------------------------------------------------
# App setup
# ------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
ALLOWED_EXTENSIONS = {"csv"}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20MB upload limit


# ------------------------------------------------------------
# In-memory dataset store (beginner-friendly)
# Note: This resets when you restart the server.
# ------------------------------------------------------------
DATASETS = {}
# DATASETS[dataset_id] = {
#   "filename": str,
#   "uploaded_path": str,
#   "created_at": iso str,
#   "original_df": pd.DataFrame,
#   "current_df": pd.DataFrame,
#   "filters": list,
# }


# ------------------------------------------------------------
# Helper functions
# ------------------------------------------------------------
def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def df_preview(df: pd.DataFrame, n: int = 10):
    preview_df = df.head(n).copy()
    preview_df = preview_df.replace({np.nan: None})
    return {
        "columns": list(preview_df.columns),
        "rows": preview_df.to_dict(orient="records"),
    }


def safe_describe(df: pd.DataFrame):
    # describe() can be large; keep it JSON-friendly
    try:
        desc = df.describe(include="all", datetime_is_numeric=True).replace({np.nan: None})
        return desc.to_dict()
    except Exception:
        return {}


def detect_column_types(df: pd.DataFrame):
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    non_numeric_cols = [c for c in df.columns if c not in numeric_cols]

    datetime_cols = []
    for c in non_numeric_cols:
        # Try to parse datetimes for columns that look like dates
        if df[c].dtype == "object" or "date" in str(c).lower() or "time" in str(c).lower():
            parsed = pd.to_datetime(df[c], errors="coerce", utc=False)
            if parsed.notna().mean() >= 0.6:  # at least 60% parseable
                datetime_cols.append(c)

    categorical_cols = []
    for c in non_numeric_cols:
        if c in datetime_cols:
            continue
        nunique = df[c].nunique(dropna=True)
        # Treat as categorical if "few" unique values relative to rows
        if len(df) == 0:
            categorical_cols.append(c)
        else:
            if nunique <= 30 or (nunique / max(len(df), 1)) <= 0.1:
                categorical_cols.append(c)

    return {
        "numeric": numeric_cols,
        "categorical": categorical_cols,
        "datetime": datetime_cols,
    }


def compute_basic_analysis(df: pd.DataFrame):
    missing_counts = df.isna().sum().to_dict()
    duplicates = int(df.duplicated().sum())

    dtypes = {c: str(t) for c, t in df.dtypes.items()}

    return {
        "shape": {"rows": int(df.shape[0]), "columns": int(df.shape[1])},
        "columns": list(df.columns),
        "dtypes": dtypes,
        "missing_values": {k: int(v) for k, v in missing_counts.items()},
        "duplicate_rows": duplicates,
        "describe": safe_describe(df),
        "detected_types": detect_column_types(df),
    }


def generate_insights(df: pd.DataFrame):
    insights = []
    recommendations = []

    if df is None or df.empty:
        return {
            "insights": ["Dataset is empty after processing. Upload a valid CSV or remove filters."],
            "recommendations": ["Try clearing filters or uploading a CSV with data."],
        }

    info = compute_basic_analysis(df)
    missing = info["missing_values"]

    # Missing values insight
    missing_cols = [c for c, v in missing.items() if v and v > 0]
    if missing_cols:
        top_missing = sorted(missing_cols, key=lambda c: missing[c], reverse=True)[:3]
        for c in top_missing:
            insights.append(f"Column '{c}' has {missing[c]} missing values.")
        recommendations.append("Consider filling or removing missing values using the Cleaning panel.")
    else:
        insights.append("No missing values detected.")

    # Duplicates insight
    dup = info["duplicate_rows"]
    if dup > 0:
        insights.append(f"Found {dup} duplicate rows.")
        recommendations.append("Consider removing duplicates to avoid skewed analysis.")
    else:
        insights.append("No duplicate rows detected.")

    # Highest average for numeric columns
    numeric_cols = info["detected_types"]["numeric"]
    if numeric_cols:
        means = df[numeric_cols].mean(numeric_only=True)
        if not means.empty:
            top_col = means.idxmax()
            top_val = float(means.max())
            insights.append(f"'{top_col}' has the highest average among numeric columns ({top_val:.4g}).")

        # Correlation insight (strong correlations)
        if len(numeric_cols) >= 2:
            corr = df[numeric_cols].corr(numeric_only=True)
            # Grab strongest non-diagonal correlation
            best = None
            best_abs = 0.0
            for a in numeric_cols:
                for b in numeric_cols:
                    if a == b:
                        continue
                    val = corr.loc[a, b]
                    if pd.isna(val):
                        continue
                    av = float(abs(val))
                    if av > best_abs:
                        best_abs = av
                        best = (a, b, float(val))
            if best and best_abs >= 0.75:
                a, b, val = best
                direction = "positive" if val > 0 else "negative"
                insights.append(
                    f"Strong {direction} correlation detected between '{a}' and '{b}' (corr={val:.2f})."
                )
                recommendations.append("Consider a scatter plot to visualize correlated numeric columns.")

        # Outlier detection (simple IQR method)
        outlier_notes = 0
        for c in numeric_cols[:8]:  # keep it fast & readable
            series = df[c].dropna()
            if len(series) < 8:
                continue
            q1 = series.quantile(0.25)
            q3 = series.quantile(0.75)
            iqr = q3 - q1
            if iqr == 0:
                continue
            lower = q1 - 1.5 * iqr
            upper = q3 + 1.5 * iqr
            outliers = ((series < lower) | (series > upper)).sum()
            if outliers > 0:
                insights.append(f"Possible outliers detected in '{c}' ({int(outliers)} values outside IQR range).")
                outlier_notes += 1
                if outlier_notes >= 3:
                    break
        if outlier_notes > 0:
            recommendations.append("Consider reviewing outliers; they can strongly affect averages and trends.")
    else:
        insights.append("No numeric columns detected. Try bar charts for categorical columns.")

    # Chart recommendations
    detected = info["detected_types"]
    if detected["categorical"]:
        recommendations.append("Use bar charts for categorical columns (counts by category).")
    if detected["numeric"]:
        recommendations.append("Use histograms to understand numeric distributions.")
    if detected["datetime"] and detected["numeric"]:
        recommendations.append("Use line charts for time-series trends (date/time vs numeric value).")

    # De-duplicate messages
    insights = list(dict.fromkeys(insights))
    recommendations = list(dict.fromkeys(recommendations))

    return {"insights": insights, "recommendations": recommendations}


def suggest_default_charts(df: pd.DataFrame):
    # Simple "AI logic" to auto-suggest a few charts
    types = detect_column_types(df)
    suggestions = []

    # Numeric histogram suggestions (up to 2)
    for c in types["numeric"][:2]:
        suggestions.append({"chartType": "histogram", "title": f"Distribution of {c}", "x": c})

    # Categorical bar suggestions (up to 2)
    for c in types["categorical"][:2]:
        suggestions.append({"chartType": "bar", "title": f"Top categories in {c}", "x": c})

    # Time-series suggestion if we have datetime + numeric
    if types["datetime"] and types["numeric"]:
        suggestions.append(
            {
                "chartType": "line",
                "title": f"Trend of {types['numeric'][0]} over {types['datetime'][0]}",
                "x": types["datetime"][0],
                "y": types["numeric"][0],
            }
        )

    return suggestions


def apply_filters(df: pd.DataFrame, filters: list):
    # filters: [{column, op, value}]
    result = df.copy()
    for f in filters or []:
        col = f.get("column")
        op = f.get("op")
        raw_val = f.get("value")
        if not col or col not in result.columns or not op:
            continue

        series = result[col]

        # Try numeric compare if column is numeric
        if pd.api.types.is_numeric_dtype(series):
            try:
                val = float(raw_val)
            except Exception:
                continue
            if op == "gt":
                result = result[series > val]
            elif op == "lt":
                result = result[series < val]
            elif op == "eq":
                result = result[series == val]
        else:
            # String compare
            val = "" if raw_val is None else str(raw_val)
            if op == "eq":
                result = result[series.astype(str) == val]
            elif op == "contains":
                result = result[series.astype(str).str.contains(val, case=False, na=False)]

    return result


def make_histogram(series: pd.Series, bins: int = 12):
    s = pd.to_numeric(series, errors="coerce").dropna()
    if s.empty:
        return {"labels": [], "data": []}
    counts, edges = np.histogram(s.values, bins=bins)
    labels = [f"{edges[i]:.3g}–{edges[i+1]:.3g}" for i in range(len(edges) - 1)]
    return {"labels": labels, "data": counts.tolist()}


def make_bar_counts(series: pd.Series, top_n: int = 12):
    s = series.dropna().astype(str)
    if s.empty:
        return {"labels": [], "data": []}
    vc = s.value_counts().head(top_n)
    return {"labels": vc.index.tolist(), "data": vc.values.astype(int).tolist()}


def make_time_series(df: pd.DataFrame, x_col: str, y_col: str):
    if x_col not in df.columns or y_col not in df.columns:
        return {"labels": [], "data": []}
    x = pd.to_datetime(df[x_col], errors="coerce")
    y = pd.to_numeric(df[y_col], errors="coerce")
    tmp = pd.DataFrame({"x": x, "y": y}).dropna()
    if tmp.empty:
        return {"labels": [], "data": []}
    tmp = tmp.sort_values("x")
    # Group by date (day) to reduce points if needed
    tmp["day"] = tmp["x"].dt.date
    grouped = tmp.groupby("day")["y"].mean()
    labels = [str(d) for d in grouped.index.tolist()]
    data = [float(v) for v in grouped.values.tolist()]
    return {"labels": labels, "data": data}


# ------------------------------------------------------------
# Routes (UI)
# ------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ------------------------------------------------------------
# Routes (API)
# ------------------------------------------------------------
@app.route("/upload", methods=["POST"])
def upload():
    # Expect: multipart/form-data with file=<csv>
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file part in the request."}), 400

    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"ok": False, "error": "No file selected."}), 400

    if not allowed_file(file.filename):
        return jsonify({"ok": False, "error": "Only .csv files are allowed."}), 400

    filename = secure_filename(file.filename)
    dataset_id = str(uuid.uuid4())
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{dataset_id}__{filename}")
    file.save(save_path)

    # Read CSV with a couple of safe fallbacks
    try:
        df = pd.read_csv(save_path)
    except UnicodeDecodeError:
        df = pd.read_csv(save_path, encoding="latin-1")
    except Exception as e:
        return jsonify({"ok": False, "error": f"Failed to read CSV: {str(e)}"}), 400

    if df is None or df.shape[1] == 0:
        return jsonify({"ok": False, "error": "CSV appears to have no columns."}), 400

    DATASETS[dataset_id] = {
        "filename": filename,
        "uploaded_path": save_path,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "original_df": df,
        "current_df": df.copy(),
        "filters": [],
    }

    analysis = compute_basic_analysis(DATASETS[dataset_id]["current_df"])
    insights_payload = generate_insights(DATASETS[dataset_id]["current_df"])
    suggestions = suggest_default_charts(DATASETS[dataset_id]["current_df"])

    return jsonify(
        {
            "ok": True,
            "dataset_id": dataset_id,
            "filename": filename,
            "preview": df_preview(DATASETS[dataset_id]["current_df"]),
            "analysis": analysis,
            "ai": {
                "insights": insights_payload["insights"],
                "recommendations": insights_payload["recommendations"],
                "suggestedCharts": suggestions,
            },
        }
    )


@app.route("/analyze", methods=["POST"])
def analyze():
    payload = request.get_json(silent=True) or {}
    dataset_id = payload.get("dataset_id")
    if not dataset_id or dataset_id not in DATASETS:
        return jsonify({"ok": False, "error": "Invalid dataset_id. Upload a CSV first."}), 400

    df = DATASETS[dataset_id]["current_df"]
    analysis = compute_basic_analysis(df)
    ai = generate_insights(df)
    suggestions = suggest_default_charts(df)

    return jsonify({"ok": True, "analysis": analysis, "ai": {**ai, "suggestedCharts": suggestions}})


@app.route("/clean", methods=["POST"])
def clean():
    payload = request.get_json(silent=True) or {}
    dataset_id = payload.get("dataset_id")
    if not dataset_id or dataset_id not in DATASETS:
        return jsonify({"ok": False, "error": "Invalid dataset_id. Upload a CSV first."}), 400

    df = DATASETS[dataset_id]["current_df"].copy()

    # Options
    remove_nulls = bool(payload.get("remove_nulls", False))
    fill_nulls = payload.get("fill_nulls")  # None | "mean" | "median" | "mode"
    remove_duplicates = bool(payload.get("remove_duplicates", False))

    # Remove duplicates
    if remove_duplicates:
        df = df.drop_duplicates()

    # Fill nulls
    if fill_nulls in {"mean", "median"}:
        num_cols = df.select_dtypes(include=[np.number]).columns
        if fill_nulls == "mean":
            df[num_cols] = df[num_cols].fillna(df[num_cols].mean(numeric_only=True))
        else:
            df[num_cols] = df[num_cols].fillna(df[num_cols].median(numeric_only=True))
    elif fill_nulls == "mode":
        for c in df.columns:
            if df[c].isna().any():
                mode = df[c].mode(dropna=True)
                if not mode.empty:
                    df[c] = df[c].fillna(mode.iloc[0])

    # Remove null rows
    if remove_nulls:
        df = df.dropna()

    # Apply existing filters again (so cleaning doesn't surprise the view)
    filters = DATASETS[dataset_id].get("filters", [])
    df = apply_filters(df, filters)

    DATASETS[dataset_id]["current_df"] = df

    analysis = compute_basic_analysis(df)
    ai = generate_insights(df)
    suggestions = suggest_default_charts(df)

    return jsonify(
        {
            "ok": True,
            "preview": df_preview(df),
            "analysis": analysis,
            "ai": {**ai, "suggestedCharts": suggestions},
        }
    )


@app.route("/filter", methods=["POST"])
def filter_data():
    payload = request.get_json(silent=True) or {}
    dataset_id = payload.get("dataset_id")
    if not dataset_id or dataset_id not in DATASETS:
        return jsonify({"ok": False, "error": "Invalid dataset_id. Upload a CSV first."}), 400

    filters = payload.get("filters") or []
    if not isinstance(filters, list):
        return jsonify({"ok": False, "error": "filters must be a list."}), 400

    base_df = DATASETS[dataset_id]["original_df"]
    # Re-apply filters from original so filters are predictable
    filtered_df = apply_filters(base_df, filters)

    DATASETS[dataset_id]["filters"] = filters
    DATASETS[dataset_id]["current_df"] = filtered_df

    analysis = compute_basic_analysis(filtered_df)
    ai = generate_insights(filtered_df)
    suggestions = suggest_default_charts(filtered_df)

    return jsonify(
        {
            "ok": True,
            "preview": df_preview(filtered_df),
            "analysis": analysis,
            "ai": {**ai, "suggestedCharts": suggestions},
        }
    )


@app.route("/chart-data", methods=["POST"])
def chart_data():
    payload = request.get_json(silent=True) or {}
    dataset_id = payload.get("dataset_id")
    if not dataset_id or dataset_id not in DATASETS:
        return jsonify({"ok": False, "error": "Invalid dataset_id. Upload a CSV first."}), 400

    df = DATASETS[dataset_id]["current_df"]
    chart_type = payload.get("chartType")

    if chart_type == "histogram":
        x = payload.get("x")
        if not x or x not in df.columns:
            return jsonify({"ok": False, "error": "Histogram requires x column."}), 400
        bins = int(payload.get("bins", 12))
        series = df[x]
        data = make_histogram(series, bins=bins)
        return jsonify({"ok": True, "chartType": "histogram", "labels": data["labels"], "data": data["data"]})

    if chart_type == "bar":
        x = payload.get("x")
        if not x or x not in df.columns:
            return jsonify({"ok": False, "error": "Bar chart requires x column."}), 400
        top_n = int(payload.get("topN", 12))
        series = df[x]
        data = make_bar_counts(series, top_n=top_n)
        return jsonify({"ok": True, "chartType": "bar", "labels": data["labels"], "data": data["data"]})

    if chart_type == "line":
        x = payload.get("x")
        y = payload.get("y")
        if not x or not y or x not in df.columns or y not in df.columns:
            return jsonify({"ok": False, "error": "Line chart requires x (datetime) and y (numeric) columns."}), 400
        data = make_time_series(df, x, y)
        return jsonify({"ok": True, "chartType": "line", "labels": data["labels"], "data": data["data"]})

    if chart_type == "scatter":
        x = payload.get("x")
        y = payload.get("y")
        if not x or not y or x not in df.columns or y not in df.columns:
            return jsonify({"ok": False, "error": "Scatter requires x and y columns."}), 400
        xs = pd.to_numeric(df[x], errors="coerce")
        ys = pd.to_numeric(df[y], errors="coerce")
        tmp = pd.DataFrame({"x": xs, "y": ys}).dropna()
        points = tmp.head(2000).to_dict(orient="records")
        return jsonify({"ok": True, "chartType": "scatter", "points": points})

    return jsonify({"ok": False, "error": "Unknown chartType."}), 400


@app.route("/download", methods=["GET"])
def download():
    dataset_id = request.args.get("dataset_id")
    if not dataset_id or dataset_id not in DATASETS:
        return jsonify({"ok": False, "error": "Invalid dataset_id."}), 400

    df = DATASETS[dataset_id]["current_df"]
    out_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{dataset_id}__download.csv")
    df.to_csv(out_path, index=False)

    return send_file(out_path, as_attachment=True, download_name="dataset_export.csv")


# ------------------------------------------------------------
# Run
# ------------------------------------------------------------
if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)

