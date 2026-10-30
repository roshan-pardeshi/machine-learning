import pandas as pd

data  = pd.read_csv('matches.csv')

print(data.head())
print(data.info())
print(data.describe())

print(data['team1'].value_counts())