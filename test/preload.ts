// Loaded before every bun test file (bunfig.toml). The scheduler refuses to run as any uid but the worker's (1000 by
// default); tests run as whoever runs them (uid 1001 on GitHub runners), so they name their own uid as the worker uid.
// A test that checks the refusal sets TM_WORKER_UID itself and restores it.
// Windows has no uids (the companion's tests run there); nothing that runs on Windows reads TM_WORKER_UID.
if (process.getuid) process.env.TM_WORKER_UID ??= String(process.getuid())
