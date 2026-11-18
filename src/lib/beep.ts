let audio: AudioContext | null = null

export function beep(kind: 'in' | 'out' | 'bad' | 'ask') {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.value = kind === 'bad' ? 196 : kind === 'out' ? 520 : kind === 'ask' ? 660 : 880
    gain.gain.value = 0.03
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start()
    osc.stop(audio.currentTime + (kind === 'bad' ? 0.16 : 0.07))
  } catch {
    // A missing speaker should not block the scan.
  }
}
