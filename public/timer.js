export default class CountdownTimer {
    constructor(durationMs, progressBarEl, overlayEl) {
        this.durationMs = durationMs;
        this.progressBarEl = progressBarEl;
        this.overlayEl = overlayEl;

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
            const width = Math.max(0, (remainingUnrounded * 100) / (/*this.durationMs / 1000*/ 90));
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
