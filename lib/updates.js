import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runShell, hasMixedPrivilegeCommand, classifySubprocessExit, canUpdateIndicatorUi, setSourceRowUpdating, requestTrackedStop, clearTrackedStopTimeout, getElapsedSeconds, extractUpdateErrorDetail, teardownTrackedUpdates, finalizeUpdateCompletion,
    createUpdateMarkerPath, buildMarkedCommand, readUpdateMarker} from './utils.js';
import {incrementPerformanceCounter, recordUpdateDuration} from './performance-counters.js';

// User-triggered update process lifecycle. All state remains owned by the
// Indicator instance; this module centralizes process launching and stopping.
    export function runInTerminal(indicator, command, key) {
        const term = indicator._settings.get_string('terminal-command');
        // #60: terminal-agnostic completion. The command writes its exit code
        // to a marker file when it finishes, so no per-terminal --wait flag is
        // needed. The configured prefix may include its own wait flag (which
        // just makes the window close); completion is driven by the marker.
        const markerPath = createUpdateMarkerPath(key);
        const wrapped = buildMarkedCommand(command, markerPath);
        const fullCommand = `${term} sh -c ${GLib.shell_quote(wrapped)}`;
        indicator._launchTracked(fullCommand, key, markerPath);
    }

    // Shared completion finalization for terminal updates (marker-driven).
    function finishTerminalUpdate(indicator, key, entry, outcome) {
        clearTrackedStopTimeout(entry, GLib.source_remove);
        if (entry.markerPollId) {
            GLib.source_remove(entry.markerPollId);
            entry.markerPollId = null;
        }
        if (entry.markerPath) {
            try { GLib.unlink(entry.markerPath); } catch (e) {}
        }
        recordUpdateDuration((GLib.get_monotonic_time() - entry.startTime) / 1000);
        if (!finalizeUpdateCompletion(indicator, key, entry))
            return;
        if (outcome.status === 'failed')
            Main.notifyError('Update command failed', 'Terminal command exited with status ' + outcome.exitStatus + '.');
        else if (outcome.status === 'signaled')
            Main.notifyError('Update command interrupted', 'Terminal command was terminated by signal ' + outcome.termSignal + '.');
        indicator._updateSyncIconState();
        indicator._setRowUpdating(key, false);
        if (indicator._updatingSources.size === 0) {
            const queue = indicator._updateAllQueue;
            if (queue && queue.activeLabel === key) {
                queue.activeLabel = null;
                queue.completed++;
                indicator._advanceUpdateAllQueue();
            } else {
                indicator.checkNow(true);
            }
        }
    }

    export function launchTracked(indicator, fullCommand, key, markerPath = null) {
        if (indicator._updatingSources.has(key)) {
            Main.notify('Update Checker', 'Already running - check the open terminal window.');
            return;
        }
        try {
            const [ok, argv] = GLib.shell_parse_argv(fullCommand);
            if (!ok)
                throw new Error('Could not parse terminal command');
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            incrementPerformanceCounter('commandsSpawned');
            incrementPerformanceCounter('updatesStarted');
            const entry = {
                proc, isTerminal: true, startTime: GLib.get_monotonic_time(),
                markerPath, markerPollId: null,
            };
            indicator._updatingSources.set(key, entry);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(key, true, '', 'terminal');

            if (markerPath) {
                // Poll for the marker the wrapped command writes on completion.
                // Bounded: stop after 6 hours so a terminated terminal cannot
                // leave a poll running forever.
                const deadline = GLib.get_monotonic_time() + 6 * 60 * 60 * 1000000;
                entry.markerPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    if (indicator._destroyed || indicator._updatingSources.get(key) !== entry) {
                        entry.markerPollId = null;
                        return GLib.SOURCE_REMOVE;
                    }
                    const status = readUpdateMarker(markerPath);
                    if (status === null) {
                        if (GLib.get_monotonic_time() > deadline) {
                            entry.markerPollId = null;
                            finishTerminalUpdate(indicator, key, entry, {status: 'unknown'});
                            return GLib.SOURCE_REMOVE;
                        }
                        return GLib.SOURCE_CONTINUE;
                    }
                    entry.markerPollId = null;
                    const outcome = classifySubprocessExit({exited: true, exitStatus: status});
                    finishTerminalUpdate(indicator, key, entry, outcome);
                    return GLib.SOURCE_REMOVE;
                });
            }

            // Reap the launcher process. With marker mode this is no longer the
            // completion signal (many terminals fork/return immediately).
            proc.wait_async(null, (proc_, res) => {
                try { proc_.wait_finish(res); } catch (e) {}
                if (!markerPath) {
                    // No marker (legacy callers) - fall back to process exit.
                    let outcome = {status: 'unknown'};
                    try {
                        const exited = proc_.get_if_exited();
                        const signaled = proc_.get_if_signaled();
                        outcome = classifySubprocessExit({
                            exited,
                            exitStatus: exited ? proc_.get_exit_status() : null,
                            signaled,
                            termSignal: signaled ? proc_.get_term_sig() : null,
                        });
                    } catch (e) {}
                    finishTerminalUpdate(indicator, key, entry, outcome);
                }
            });
        } catch (e) {
            Main.notifyError('Update Checker', `Could not launch terminal: ${e.message}`);
        }
    }

    // Directly mutates a source's already-rendered row to show/hide the
    // "Updating..." state, without needing a checkNow() rebuild - which
    // matters since checkNow() deliberately skips itself entirely while
    // an update is in progress (see the guard at the top of checkNow).
    export function setRowUpdating(indicator, name, isUpdating, elapsedText, mode = 'background') {
        if (!canUpdateIndicatorUi(indicator))
            return;
        return setSourceRowUpdating(indicator._sourceRowWidgets.get(name), isUpdating, elapsedText, mode);
    }

    export function stopSourceUpdate(indicator, label) {
        const entry = indicator._updatingSources.get(label);
        if (!entry || entry.stopped)
            return;

        // The tracked process is a session leader, so signal the entire
        // update process group rather than only the shell/pkexec wrapper.
        // This prevents package managers from continuing after the UI says
        // the update was stopped.
        const signalGroup = (signal) => {
            const identifier = entry.proc.get_identifier();
            if (!identifier || !/^\d+$/.test(identifier))
                return;
            try {
                const killer = Gio.Subprocess.new(
                    ['/usr/bin/kill', `-${signal}`, '--', `-${identifier}`],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
                );
                killer.wait_async(null, (killerProc, result) => {
                    try { killerProc.wait_finish(result); } catch (e) {}
                });
            } catch (e) {
                // Completion callback still owns UI cleanup; a failed signal
                // must not make the extension throw from a button handler.
            }
        };

        // Keep the delayed force-kill tied to the same tracked entry so a
        // completed update cannot signal a reused process identifier.
        requestTrackedStop(
            entry,
            (delayMs, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            () => indicator._updatingSources.get(label) === entry,
            signal => signalGroup(signal),
            2000
        );
    }

    // #84: tear down all tracked updates on indicator destruction. Delegate the
    // pure timer/entry lifecycle to utils so it can be unit tested; supply the
    // real process-group TERM signal here.
    export function teardownUpdates(indicator) {
        return teardownTrackedUpdates(indicator?._updatingSources, {
            cancelTimeout: id => GLib.source_remove(id),
            removeMarker: path => { try { GLib.unlink(path); } catch (e) {} },
            signalEntry: entry => {
                const proc = entry?.proc;
                const identifier = proc?.get_identifier?.();
                if (!identifier || !/^\d+$/.test(identifier))
                    return;
                try {
                    const killer = Gio.Subprocess.new(
                        ['/usr/bin/kill', '-TERM', '--', `-${identifier}`],
                        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                    killer.wait_async(null, (k, res) => { try { k.wait_finish(res); } catch (e) {} });
                } catch (e) {}
            },
        });
    }

    export function stopAllUpdates(indicator) {
        for (const label of [...indicator._updatingSources.keys()])
            stopSourceUpdate(indicator, label);
    }


    export function runInBackground(indicator, command, label) {
        if (indicator._updatingSources.has(label)) {
            Main.notify(`${label} update already running`, 'Wait for it to finish first.');
            return;
        }

        const connectivity = Gio.NetworkMonitor.get_default().get_connectivity();
        // This is an explicit user action, so allow LIMITED connectivity:
        // package repositories may still be reachable even when GNOME's
        // connectivity probe cannot confirm full internet access. Keep
        // rejecting LOCAL/NONE and captive-portal states with a clear message.
        const canAttemptUpdate = connectivity === Gio.NetworkConnectivity.FULL ||
            connectivity === Gio.NetworkConnectivity.LIMITED;
        if (!canAttemptUpdate) {
            const reason = connectivity === Gio.NetworkConnectivity.PORTAL
                ? 'The network requires sign-in before updates can run.'
                : 'No usable internet connection detected.';
            Main.notifyError(`${label} update not started`, reason);
            return;
        }

        if (hasMixedPrivilegeCommand(command) && !indicator._settings.get_boolean('bypass-mixed-privilege-command')) {
            Main.notifyError(
                `${label} update not started`,
                'Background mode would elevate the entire chained command. Split privileged and user-scoped steps into separate sources or use terminal mode.');
            return;
        }

        // Background mode has no terminal to prompt for a password, so any
        // doas/sudo prefix is stripped and the whole line is re-run under
        // pkexec instead (graphical, PolicyKit-mediated auth). NOTE: this
        // Mixed privileged/unprivileged shell commands are rejected above.
        // A remaining privilege prefix applies to this single source command.
        const hasPrivilege = /\b(?:doas|sudo|pkexec)\s+/.test(command);
        const cleaned = command.replace(/\b(?:doas|sudo|pkexec)\s+/g, '');
        const argv = hasPrivilege ? ['pkexec', 'sh', '-c', cleaned] : ['sh', '-c', cleaned];

        Main.notify(`Updating ${label}...`, 'Running in background.');
        try {
            // Isolate each background update in its own session/process group
            // so Stop Updating can terminate the package manager and its children.
            const proc = Gio.Subprocess.new(
                ['/usr/bin/setsid', ...argv],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            incrementPerformanceCounter('commandsSpawned');
            incrementPerformanceCounter('updatesStarted');

            const entry = {
                proc,
                startTime: GLib.get_monotonic_time(),
                isTerminal: false,
                stopped: false,
                tickId: null,
                stopTimeoutId: null,
            };
            indicator._updatingSources.set(label, entry);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(label, true, '0s', 'background');

            entry.tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                if (!canUpdateIndicatorUi(indicator)) {
                    entry.tickId = null;
                    return GLib.SOURCE_REMOVE;
                }
                const elapsed = getElapsedSeconds(entry.startTime, GLib.get_monotonic_time());
                indicator._setRowUpdating(label, true, `${elapsed}s`, 'background');
                return GLib.SOURCE_CONTINUE;
            });

            proc.communicate_utf8_async(null, null, (proc_, res) => {
                if (entry.tickId) {
                    GLib.source_remove(entry.tickId);
                    entry.tickId = null;
                }
                clearTrackedStopTimeout(entry, GLib.source_remove);
                let ok = false, stderr = '';
                try {
                    const [, , errOut] = proc_.communicate_utf8_finish(res);
                    stderr = errOut ?? '';
                    ok = proc_.get_exit_status() === 0;
                } catch (e) {
                    stderr = String(e);
                }
                recordUpdateDuration((GLib.get_monotonic_time() - entry.startTime) / 1000);
                // Guard against destroyed indicator and stale entry, remove the
                // tracked entry, and invalidate this source's poll/result cache.
                if (!finalizeUpdateCompletion(indicator, label, entry))
                    return;
                indicator._updateSyncIconState();
                indicator._setRowUpdating(label, false);
                if (entry.stopped)
                    Main.notify(`${label} update stopped`, 'Stopped before it finished.');
                else if (ok)
                    Main.notify(`${label} updated`, 'Finished successfully.');
                else {
                    const low = stderr.toLowerCase();
                    const cancelled = low.includes('dismissed') || low.includes('cancel') ||
                        low.includes('not authorized') || low.includes('auth could not be obtained');
                    if (cancelled) {
                        Main.notify(`${label} update cancelled`, 'Authentication cancelled.');
                    } else {
                        // Show the actual failure reason (e.g. an unsatisfiable
                        // repo dependency), not just the "Updating and loading
                        // repositories:" banner that DNF prints first.
                        const detail = extractUpdateErrorDetail(stderr);
                        Main.notifyError(`${label} update failed`,
                            detail || stderr.trim().split('\n')[0] || 'Unknown error');
                    }
                }
                // Re-check either way - success needs a fresh count,
                // and failure/stop needs a fresh look at what's still
                // actually pending, since a partial run may have
                // changed the real state even if it didn't finish.
                // Invalidate cached poll for this source so the
                // per-source interval cache (checkNow's `manual=false`
                // fast-path at extension.js:738) doesn't reuse the
                // stale pre-update count. Without this, the immediate
                // re-check would see `now - last < 60m` and return the
                // old `1` instead of the real `0` until the interval
                // expires or the user clicks "Check Now" (manual=true).
                const queue = indicator._updateAllQueue;
                if (queue && queue.activeLabel === label) {
                    queue.activeLabel = null;
                    queue.completed++;
                    indicator._advanceUpdateAllQueue();
                } else {
                    indicator.checkNow(true);
                }
            });
        } catch (e) {
            indicator._updatingSources.delete(label);
            indicator._updateSyncIconState();
            indicator._setRowUpdating(label, false);
            Main.notifyError('Update Checker', `Could not run update: ${e.message}`);
        }
    }

    export function runSourceUpdate(indicator, command, label) {
        if (indicator._settings.get_boolean('background-updates'))
            indicator._runInBackground(command, label);
        else
            indicator._runInTerminal(command, label);
    }

    export function runUpdateScript(indicator) {
        const path = indicator._settings.get_string('update-script-path');
        if (!path)
            return;
        const term = indicator._settings.get_string('terminal-command');
        const markerPath = createUpdateMarkerPath('__script__');
        const wrapped = buildMarkedCommand(path, markerPath);
        const fullCommand = `${term} sh -c ${GLib.shell_quote(wrapped)}`;
        indicator._launchTracked(fullCommand, '__script__', markerPath);
    }

