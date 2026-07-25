HAPA OWNER ROLE FIX

This package fixes the duplicate Owner-role problem.

Files changed:
- server.js
- sql/schema.sql

Expected result after deployment:
- Trader2027@protonmail.com = the only owner
- Moreentrader@gmail.com = customer, active
- all other accidental owners = customer

Upload the two changed files preserving their paths, commit, then deploy the latest commit on Render.
