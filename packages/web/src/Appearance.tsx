import { Check, Desktop, Moon, Sun } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { EASE_OUT } from './motion.ts'

export type Mode = 'light' | 'dark' | 'system'
export type Palette = 'grafite' | 'meia-noite' | 'brasa' | 'mono' | 'ardosia'

/** Cores só da miniatura: fundo, barra lateral, texto forte, texto fraco, destaque. As de verdade moram no app.css. */
export const PALETTES: Array<{ id: Palette; name: string; note: string; swatch: [string, string, string, string, string] }> = [
  { id: 'grafite', name: 'Grafite', note: 'Grafite neutro com batuta dourada e luz azul de palco', swatch: ['#121216', '#1a1a20', '#ecebe8', '#5f5f6e', '#f0b43c'] },
  { id: 'meia-noite', name: 'Meia-noite', note: 'Azul-violeta profundo com destaques frios', swatch: ['#0c0e1f', '#13162c', '#e9eaf5', '#4f5584', '#a9b6ff'] },
  { id: 'brasa', name: 'Brasa', note: 'Carvão quente com cobre, clima de forja', swatch: ['#15100d', '#1e1612', '#f1e8e2', '#6b5446', '#ec7a43'] },
  { id: 'mono', name: 'Mono', note: 'Tons de cinza, mínimo e concentrado', swatch: ['#111111', '#191919', '#ededed', '#5c5c5c', '#f5f5f5'] },
  { id: 'ardosia', name: 'Ardósia', note: 'Azul-ardósia frio, tema de quem programa', swatch: ['#0f141b', '#161d26', '#e6edf3', '#4d6072', '#79b8ff'] },
]

const MODES: Array<{ id: Mode; name: string; note: string; Icon: typeof Sun }> = [
  { id: 'light', name: 'Claro', note: 'Superfícies claras de dia', Icon: Sun },
  { id: 'dark', name: 'Escuro', note: 'Pouco brilho para longas sessões', Icon: Moon },
  { id: 'system', name: 'Sistema', note: 'Segue o modo do computador', Icon: Desktop },
]

const rise = (i: number) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: EASE_OUT, delay: 0.05 * i } })

/** Aparência: o modo muda o brilho; a paleta muda as cores e a luz de palco. As duas combinam entre si. */
export default function Appearance({ mode, palette, onMode, onPalette }: { mode: Mode; palette: Palette; onMode: (m: Mode) => void; onPalette: (p: Palette) => void }) {
  return (
    <section className="settings">
      <motion.header {...rise(0)} style={{ display: 'grid', gap: '1rem' }}>
        <h1 className="display">Aparência</h1>
        <p className="lede">O modo controla o brilho; a paleta controla as cores. Vale só para este computador.</p>
      </motion.header>

      <motion.div className="setting" {...rise(1)}>
        <header><h2 id="mode-label">Modo</h2></header>
        <div className="options" role="radiogroup" aria-labelledby="mode-label">
          {MODES.map(({ id, name, note, Icon }) => (
            <button key={id} className="option" role="radio" aria-checked={mode === id} onClick={() => onMode(id)}>
              <span className="icon"><Icon size={18} weight="light" aria-hidden="true" /></span>
              <strong>{name}</strong>
              <small>{note}</small>
              {mode === id && <span className="check"><Check size={12} weight="bold" aria-hidden="true" /></span>}
            </button>
          ))}
        </div>
      </motion.div>

      <motion.div className="setting" {...rise(2)}>
        <header><h2 id="palette-label">Paleta</h2></header>
        <div className="options palettes" role="radiogroup" aria-labelledby="palette-label">
          {PALETTES.map(({ id, name, note, swatch: [ground, side, strong, weak, accent] }) => (
            <button key={id} className="option" role="radio" aria-checked={palette === id} onClick={() => onPalette(id)}>
              <span className="swatch" aria-hidden="true" style={{ background: ground }}>
                <i style={{ background: side }} />
                <span className="main">
                  <b style={{ width: '48%', background: strong }} />
                  <b style={{ width: '70%', background: weak }} />
                  <em style={{ background: accent }} />
                </span>
              </span>
              <strong>{name}</strong>
              <small>{note}</small>
              {palette === id && <span className="check"><Check size={12} weight="bold" aria-hidden="true" /></span>}
            </button>
          ))}
        </div>
      </motion.div>
    </section>
  )
}
