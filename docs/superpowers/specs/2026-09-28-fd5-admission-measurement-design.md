# FD5 admission measurement design

FD5 measures the shared reader budget under real capture. The four arms are
baseline, clip-only, interface-only, and combined. They reuse the B2 benchmark's
fresh disposable store, real watcher, worker-thread writer, durable-boundary
timestamps, cold corpus, paired repetitions, and capture bar. Each interface
request contains one language so timeout rates are attributable to TS, TSX, or
Swift. The corpus includes representative, malformed, and Unicode source.

The admission budget retains one shared C/Q/W. Its default deadline remains
100 ms for clip. A private interface request may set its own deadline, including
queue wait; the HTTP client cannot set it. A reader test seam lets the benchmark
measure candidate interface deadlines without changing production defaults.
Production numbers remain provisional until Brian approves measured C/Q/W/D and
acceptable timeout rates. An independent QA-daemon HTTP consumer checks the
production choice against recorded edits and schema with every UI stopped.

Each full arm writes 100 scheduled and 100 burst files, repeated three times.
Capture p50 and p99 for overall/scheduled/burst must be at most 1.20 times the
paired baseline; throughput must be at least 0.95 times baseline; missing writes
must be zero. Load sufficiency requires cold parses and overloads during capture,
continuous request coverage, and no crashes or lost responses. The report keeps
raw responses, timeout/overload counts by workload and language, host samples,
cancelled request outcomes, and child/worker cleanup evidence. Cold uncached,
subsequent uncached, and cache-hit latency are labeled separately. A large-log
sample exposes range-scan cost.

If the bar fails, record the measurements and stop. Do not relax clip's 100 ms
deadline, capture settings, or the success criteria to fit a chosen value.
