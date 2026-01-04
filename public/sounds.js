export class SoundManager {
  constructor() {
      this.sounds = new Map();
      this.unlocked = false;

      // Preload sounds here
      this.add("ante", "./sounds/ante.wav", 1.0); 
      this.add("call", "./sounds/call.wav", 0.9);
      this.add("check", "./sounds/check.wav", 0.8);
      this.add("raise", "./sounds/raise.wav", 0.6);
      this.add("raise10", "./sounds/raise10.wav", 0.6);
      this.add("deal", "./sounds/deal.wav", 1.0); //
      this.add("deal2", "./sounds/deal2.wav", 0.8);
      this.add("deal3", "./sounds/deal3.wav", 0.8);
      this.add("discard", "./sounds/discard.wav", 0.8);
      this.add("discard2", "./sounds/discard2.wav", 0.8);
      this.add("fold", "./sounds/fold.wav", 0.8);
      this.add("fold2", "./sounds/fold2.wav", 0.8);
      this.add("hiloselect", "./sounds/hiloselect.wav", 1.0); //
      this.add("newhand", "./sounds/newhand.wav", 0.6);
      this.add("start", "./sounds/start.wav", 0.1);
      this.add("end", "./sounds/end.wav", 0.1);
      this.add("eliminated", "./sounds/eliminated.wav", 0.1);

      // Unlock audio on first user interaction
      const unlockHandler = () => {
          this.unlocked = true;
          // "prime" the sounds
          for (const sound of this.sounds.values()) {
            sound.volume = 0;
            sound.play().catch(() => {});
            sound.pause();
            sound.currentTime = 0;
            sound.volume = sound._volume || sound.volume;
          }
          window.removeEventListener("click", unlockHandler);
          window.removeEventListener("keydown", unlockHandler);
      };
      window.addEventListener("click", unlockHandler);
      window.addEventListener("keydown", unlockHandler);
  }

  add(name, src, volume = 1.0) {
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = volume;
    audio._volume = volume;
    this.sounds.set(name, audio);
}

  play(name) {
      const sound = this.sounds.get(name);
      if (!sound || !this.unlocked) return;
      sound.currentTime = 0;
      sound.play().catch(err => console.warn("Play failed:", err));
  }

  setVolume(name, volume) {
      const sound = this.sounds.get(name);
      if (sound) sound.volume = volume;
  }
}
