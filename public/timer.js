export default class CountdownTimer {
    // totalSeconds is the FULL phase length, used only for the progress-bar width fraction
    // (remaining / total). It can differ from durationMs/1000 when starting mid-phase (a
    // rejoin, or a swing player who already spent time in the modal). Defaults to the full
    // duration when omitted. The overlay countdown number never depends on it.
    constructor(durationMs, progressBarEl, overlayEl, totalSeconds) {
        this.durationMs = durationMs;
        this.progressBarEl = progressBarEl;
        this.overlayEl = overlayEl;
        this.totalSeconds = totalSeconds ?? (durationMs / 1000);

        this.startTime = null;
        this.endTime = null;
        this.rafId = null;
    }

    start() {
        this.startTime = Date.now();
        this.endTime = this.startTime + this.durationMs;
        this.update(); // kick it off
    }

    update = () => {
        const now = Date.now();
        const remainingUnrounded = (this.endTime - now) / 1000;
        const remaining = Math.max(0, Math.floor(remainingUnrounded));

        if (this.overlayEl) {
            this.overlayEl.textContent = remaining;
        }

        if (this.progressBarEl) {
            const width = Math.max(0, (remainingUnrounded * 100) / this.totalSeconds);
            this.progressBarEl.style.width = width + "%";
        }

        if (remaining > 0) {
            this.rafId = requestAnimationFrame(this.update);
        }
    };

    stop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}
