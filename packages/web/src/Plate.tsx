import { useEffect } from 'react'
import { motion, useMotionValue, useScroll, useSpring, useTransform } from 'motion/react'
import { reducedMotion } from './motion.ts'
import maestro from './assets/plates/maestro.webp'
import estante from './assets/plates/estante.webp'
import afinacao from './assets/plates/afinacao.webp'
import coda from './assets/plates/coda.webp'

const PLATES = {
  maestro: [maestro, 'Gravura de um regente de costas, com seis braços, cada mão conduzindo um fio'],
  estante: [estante, 'Gravura de uma estante de partitura sob uma luminária'],
  afinacao: [afinacao, 'Gravura de mãos afinando um violino ao lado de um diapasão'],
  coda: [coda, 'Gravura de um regente agradecendo ao fim do concerto'],
} as const

// Ponteiro normalizado (-1 a 1) compartilhado por todas as gravuras: um só ouvinte na janela.
const pointer = { x: 0, y: 0, subs: new Set<() => void>() }
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1
    for (const f of pointer.subs) f()
  }, { passive: true })
}

const SPRING = { stiffness: 55, damping: 18, mass: 0.6 }

/**
 * Gravura impressa em branco sobre o campo de cor da paleta, em duas camadas com parallax: a gravura anda com a rolagem
 * e segue o mouse; a retícula do fundo vai ao contrário. Com movimento reduzido, tudo fica parado.
 */
export default function Plate({ name, className = '', decorative = false, depth = 1 }: { name: keyof typeof PLATES; className?: string; decorative?: boolean; depth?: number }) {
  const [src, alt] = PLATES[name]
  const still = reducedMotion()
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  useEffect(() => {
    if (still) return
    const f = () => { mx.set(pointer.x); my.set(pointer.y) }
    pointer.subs.add(f)
    return () => { pointer.subs.delete(f) }
  }, [still, mx, my])
  const { scrollY } = useScroll()
  const px = useSpring(useTransform(mx, (v) => v * -16 * depth), SPRING)
  const py = useSpring(useTransform(my, (v) => v * -10 * depth), SPRING)
  const scrollShift = useTransform(scrollY, (v) => v * -0.12 * depth)
  const imgY = useTransform(() => py.get() + scrollShift.get())
  const dotX = useSpring(useTransform(mx, (v) => v * 8 * depth), SPRING)
  const dotY = useTransform(() => my.get() * 6 * depth + scrollY.get() * 0.05 * depth)

  return (
    <figure className={`plate-field ${className}`}>
      <motion.span className="plate-dots" aria-hidden="true" style={still ? undefined : { x: dotX, y: dotY }} />
      {/* A gravura é máscara: a tinta vem do tema (branca à noite, marinho de dia), sem precisar de duas tiragens. */}
      <motion.span
        className="plate"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : alt}
        aria-hidden={decorative || undefined}
        style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})`, ...(still ? {} : { x: px, y: imgY, scale: 1.04 }) }}
      />
    </figure>
  )
}
