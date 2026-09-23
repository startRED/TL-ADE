import { Children, cloneElement, createContext, isValidElement, useContext, useId, type CSSProperties, type ChangeEvent, type ElementType, type ReactElement, type ReactNode } from 'react'

/*
 * Primitivas no estilo da Partitura para as telas que nasceram com Radix (Conversa, Modelos, Skills, Opções).
 * Mesma forma de uso, elementos nativos e as classes do app.css: a semântica (papéis e rótulos) segue a do HTML.
 */

type Space = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
const SPACE: Record<Space, string> = { 0: '0', 1: '.25rem', 2: '.5rem', 3: '.75rem', 4: '1rem', 5: '1.5rem', 6: '2rem', 7: '2.5rem', 8: '3rem', 9: '4rem' }
const space = (v?: string) => (v ? SPACE[v as Space] : undefined)
const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ')

type Common = { className?: string; style?: CSSProperties; children?: ReactNode; role?: string; id?: string; 'aria-label'?: string; 'aria-live'?: 'polite' | 'assertive' | 'off'; 'data-testid'?: string }

export function Flex({ direction, gap, align, justify, wrap, mb, className, style, children, ...rest }: Common & { direction?: 'row' | 'column'; gap?: string; align?: string; justify?: string; wrap?: 'wrap' | 'nowrap'; mb?: string }) {
  const flexAlign = align === 'start' || align === 'end' ? `flex-${align}` : align
  const flexJustify = justify === 'between' ? 'space-between' : justify === 'start' || justify === 'end' ? `flex-${justify}` : justify
  return <div className={className} style={{ display: 'flex', flexDirection: direction, gap: space(gap), alignItems: flexAlign, justifyContent: flexJustify, flexWrap: wrap, marginBottom: space(mb), minWidth: 0, ...style }} {...rest}>{children}</div>
}

const TONE: Record<string, string> = { gray: 'var(--ink-soft)', red: 'var(--danger, #ff8a7a)', green: 'var(--ok, #8fe3b0)', amber: 'var(--baton-text)', orange: 'var(--baton-text)' }

export function Text({ as = 'span', size, color, weight, mb, className, style, children, ...rest }: Common & { as?: 'span' | 'p' | 'div' | 'label'; size?: string; color?: string; weight?: 'regular' | 'medium' | 'bold'; mb?: string }) {
  const Tag = as as ElementType
  const fontSize = size === '1' ? '12px' : size === '2' ? '13.5px' : size === '3' ? '15px' : size ? '17px' : undefined
  return <Tag className={className} style={{ fontSize, color: color ? TONE[color] ?? undefined : undefined, fontWeight: weight === 'bold' ? 600 : weight === 'medium' ? 500 : undefined, marginBottom: space(mb), ...style }} {...rest}>{children}</Tag>
}

export function Heading({ as = 'h2', size, mb, className, style, children, ...rest }: Common & { as?: 'h1' | 'h2' | 'h3' | 'h4'; size?: string; mb?: string }) {
  const Tag = as as ElementType
  const big = Number(size) >= 6
  return <Tag className={cx(big ? 'display' : 'ui-heading', className)} style={{ fontSize: big ? 'clamp(3rem, 5vw, 5rem)' : undefined, marginBottom: space(mb), ...style }} {...rest}>{children}</Tag>
}

export function Card({ asChild, className, children, ...rest }: Common & { asChild?: boolean }) {
  if (asChild && isValidElement<{ className?: string }>(children)) {
    const child = children as ReactElement<{ className?: string }>
    return cloneElement(child, { className: cx('ui-card', child.props.className, className) })
  }
  return <div className={cx('ui-card', className)} {...rest}>{children}</div>
}

export function Badge({ color, className, children, ...rest }: Common & { color?: string; variant?: string }) {
  return <span className={cx('tag', color === 'green' ? 'ok' : color === 'red' ? 'bad' : color === 'amber' || color === 'orange' ? 'yellow' : undefined, className)} {...rest}>{children}</span>
}

type ButtonProps = Common & {
  type?: 'button' | 'submit' | 'reset'; disabled?: boolean; onClick?: () => void; variant?: string; color?: string; size?: string
  'aria-expanded'?: boolean; 'aria-pressed'?: boolean; title?: string
}
export function Button({ type = 'button', variant, color, size, className, children, ...rest }: ButtonProps) {
  const quiet = variant === 'ghost' || variant === 'soft' || variant === 'outline' || variant === 'surface'
  return <button type={type} className={cx('btn', !quiet && color !== 'red' && 'baton', color === 'red' && 'danger', size === '1' && 'small', className)} {...rest}>{children}</button>
}

type FieldProps = Common & {
  value?: string | number; onChange?: (e: ChangeEvent<HTMLInputElement>) => void; placeholder?: string; type?: string
  min?: number | string; max?: number | string; step?: number | string; disabled?: boolean; size?: string; variant?: string; color?: string; name?: string
}
function FieldRoot({ className, children, size: _size, variant: _variant, color: _color, ...rest }: FieldProps) {
  const slot = Children.toArray(children)
  return (
    <span className={cx('ui-field', className)}>
      {slot.length > 0 && <span className="ui-slot" aria-hidden="true">{slot}</span>}
      <input className="field" {...rest} />
    </span>
  )
}
function FieldSlot({ children }: { children?: ReactNode }) { return <>{children}</> }
export const TextField = { Root: FieldRoot, Slot: FieldSlot }

export function TextArea({ className, variant: _variant, ...rest }: Common & { value?: string; onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void; placeholder?: string; rows?: number; disabled?: boolean; variant?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void }) {
  return <textarea className={cx('field', className)} {...rest} />
}

export function Switch({ checked, onCheckedChange, disabled, 'aria-label': label, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx('ui-switch', className)} onClick={() => onCheckedChange(!checked)}>
      <span className="track" aria-hidden="true" />
    </button>
  )
}

const RadioCtx = createContext<{ name: string; value?: string; onValueChange?: (v: string) => void }>({ name: '' })
function RadioRoot({ value, onValueChange, children, 'aria-label': label, className }: Common & { value?: string; onValueChange?: (v: string) => void }) {
  const name = useId()
  return <RadioCtx.Provider value={{ name, value, onValueChange }}><div role="radiogroup" aria-label={label} className={cx('choices', className)}>{children}</div></RadioCtx.Provider>
}
function RadioItem({ value, children }: { value: string; children?: ReactNode }) {
  const group = useContext(RadioCtx)
  return (
    <label className="choice">
      <input type="radio" name={group.name} value={value} checked={group.value === value} aria-checked={group.value === value} onChange={() => group.onValueChange?.(value)} />
      <span>{children}</span>
    </label>
  )
}
export const RadioGroup = { Root: RadioRoot, Item: RadioItem }
