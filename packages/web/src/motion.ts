import Lenis from 'lenis'

/** Saída exponencial: tudo que entra desacelera como tinta assentando no papel. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

let lenis: Lenis | null = null

/** Rolagem suave com inércia na página inteira; com movimento reduzido fica a rolagem nativa. */
export function startSmoothScroll(): void {
  if (reducedMotion()) return
  const instance = new Lenis({ duration: 1.1, easing: (t) => 1 - Math.pow(2, -10 * t), wheelMultiplier: 0.9 })
  lenis = instance
  const frame = (time: number) => {
    instance.raf(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/**
 * Volta ao topo pela mesma rolagem que a página usa. O scrollTo nativo por baixo do Lenis deixa a posição e o
 * limite dele velhos quando a tela troca de altura (plano recusado vira partitura), e a barra fixa do pedido
 * aparece pintada por cima da conversa até a próxima rolagem.
 */
export function scrollToTop(smooth = false): void {
  if (!lenis) {
    window.scrollTo(0, 0)
    return
  }
  lenis.resize()
  lenis.scrollTo(0, { immediate: !smooth, force: true })
}
