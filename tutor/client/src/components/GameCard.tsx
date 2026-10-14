/** One card on the table: image when visible, tapped/attacking/sickness and counters shown. */
export function GameCard({ c, selectable, selected, onClick, small }: { c: any; selectable?: boolean; selected?: boolean; onClick?: () => void; small?: boolean }) {
  const cls = ['gcard', c.tapped ? 'tapped' : '', c.attacking ? 'attacking' : '', selectable ? 'selectable' : '', selected ? 'selected' : '', small ? 'small' : '', c.isLand ? 'land' : ''].filter(Boolean).join(' ');
  const counters = c.counters ? Object.entries(c.counters) : [];
  return (
    <button className={cls} onClick={onClick} aria-label={`${c.name}${c.tapped ? ', tapped' : ''}${c.attacking ? ', attacking' : ''}${selectable ? ', can act' : ''}`} title={c.name}>
      {c.image && !c.hidden ? <img src={c.image} alt="" loading="lazy" /> : <span className="gname">{c.name}</span>}
      {c.image && !c.hidden && <span className="gname overlay">{c.name}</span>}
      {c.isCreature && <span className="pt">{c.power}/{c.toughness}{c.damage ? ` (-${c.damage})` : ''}</span>}
      {c.loyalty !== undefined && <span className="pt">◆{c.loyalty}</span>}
      {counters.length > 0 && <span className="counters">{counters.map(([k, v]) => `${v} ${k}`).join(', ')}</span>}
      {c.sick && c.isCreature && <span className="flag">sick</span>}
      {c.token && <span className="flag tok">token</span>}
    </button>
  );
}
