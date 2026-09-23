import { Check, Desktop, Moon, Sun } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { EASE_OUT } from './motion.ts'

export type Mode = 'light' | 'dark' | 'system'
export type Palette = 'cobalto' | 'violeta' | 'brasa' | 'oceano' | 'grafite' | 'mono'

/** Cores só da miniatura: fundo, campo de cor, texto forte, texto fraco, batuta. As de verdade moram no app.css. */
export const PALETTES: Array<{ id: Palette; name: string; note: string; swatch: [string, string, string, string, string] }> = [
  { id: 'cobalto', name: 'Cobalto', note: 'Azul-marinho com campo cobalto e batuta dourada', swatch: ['#0b1030', '#2b3de0', '#eef0ff', '#4150a6', '#ffc53d'] },
  { id: 'violeta', name: 'Violeta', note: 'Noite violeta com campo ultravioleta', swatch: ['#140c2c', '#6d3df0', '#f2eeff', '#5a47a3', '#ffd166'] },
  { id: 'brasa', name: 'Brasa', note: 'Carvão quente com campo laranja de forja', swatch: ['#1a0d08', '#d9480f', '#fff0e6', '#8a4a30', '#ffc15a'] },
  { id: 'oceano', name: 'Oceano', note: 'Verde-azulado profundo com campo turquesa', swatch: ['#04191e', '#0b8f9e', '#e8fbff', '#2c6f7a', '#ffd45c'] },
  { id: 'grafite', name: 'Grafite', note: 'Grafite neutro, cor só no campo das gravuras', swatch: ['#121216', '#3a46c4', '#ecebe8', '#5f5f6e', '#f0b43c'] },
  { id: 'mono', name: 'Mono', note: 'Tons de cinza, mínimo e concentrado', swatch: ['#111111', '#2b2b2b', '#ededed', '#5c5c5c', '#f5f5f5'] },
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
