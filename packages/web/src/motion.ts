import Lenis from 'lenis'

/** Saída exponencial: tudo que entra desacelera como tinta assentando no papel. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Rolagem suave com inércia na página inteira; com movimento reduzido fica a rolagem nativa. */
export function startSmoothScroll(): void {
  if (reducedMotion()) return
  const lenis = new Lenis({ duration: 1.1, easing: (t) => 1 - Math.pow(2, -10 * t), wheelMultiplier: 0.9 })
  const frame = (time: number) => {
    lenis.raf(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
