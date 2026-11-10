# trackman-coach

A phone web page that watches a TrackMan simulator/range session and speaks the result plus one piece of
advice after every shot, with a summary every 5 shots.

Open https://whauman.github.io/trackman-coach/ with a TrackMan API token in the URL fragment (`#t=…`). The token
is stored only in the phone's browser storage and is sent only to `api.trackmangolf.com`. Nothing else leaves
the phone. This repo holds no shot data or credentials.

Coaching rules and thresholds live in `advice.mjs`. Source of truth is the private `trackman-metrics` repo
(`coach/`); this repo is published from there.
