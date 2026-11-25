# Scheduler tests

`simulate.js` runs the real `index.html` in headless Chromium and checks that shuffles stay fair and varied.
It needs Playwright (`npm i -g playwright`).

```bash
# 6-8 players, 1 and 2 courts, both modes (defaults)
NODE_PATH=$(npm root -g) node tests/simulate.js

# every size, 1 court for the first 4 rounds then 2 courts (a common real session)
NODE_PATH=$(npm root -g) node tests/simulate.js --players 4-12 --switch 4

# players leaving / joining mid-session
NODE_PATH=$(npm root -g) node tests/simulate.js --players 6-9 --courts 2 --churn
```

Columns: rounds until every partner / opponent / solo pair has met (`miss` = sessions that never did),
distinct solo pairs seen, back-to-back solos, and the max-min spread of solos / rests / games played.
It exits non-zero if a round has a duplicated or missing player, a page error occurs, or the same
person plays solo twice in a row with 6+ players available.

Known limits (not bugs): with 1 court and 8+ players it takes 40+ rounds to cover every pair.
Solo matches only occur with 2 courts and 6 or 7 players (6: 1v1, 7: 1v1 + one rests, or 1v2).
With `--churn`, players come and go on purpose, so the spread columns are not meaningful there; look at `issues` and `b2b`.
