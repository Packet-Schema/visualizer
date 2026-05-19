import type { CSSProperties } from "react";

type Props = {
  rowBits: number;
};

/**
 * A thin bit-position ruler displayed above the HybridDiagram grid.
 *
 * Uses HTML + CSS rather than SVG so the column widths stay perfectly in sync
 * with the `grid-template-columns: repeat(rowBits, 1fr)` grid below. Major
 * ticks fall every 8 bits (byte boundaries), minor ticks every bit.
 */
export default function DiagramRuler({ rowBits }: Props) {
  const cells: React.ReactNode[] = [];
  for (let b = 0; b < rowBits; b++) {
    const major = b % 8 === 0;
    const showLabel = b % 4 === 0;
    cells.push(
      <div
        key={b}
        className={`ruler-cell${major ? " ruler-cell-major" : ""}`}
        aria-hidden="true"
      >
        {showLabel ? <span className="ruler-label">{b}</span> : null}
        <span
          className={major ? "ruler-tick-major" : "ruler-tick-minor"}
          aria-hidden="true"
        />
      </div>,
    );
  }

  const style: CSSProperties = {
    gridTemplateColumns: `repeat(${rowBits}, minmax(0, 1fr))`,
  };

  return (
    <div className="diagram-ruler" role="presentation" style={style}>
      {cells}
    </div>
  );
}
