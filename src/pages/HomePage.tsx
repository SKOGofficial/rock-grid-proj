/**
 * The landing page: what the project is, and every strategy on the table.
 *
 * Summary:
 *   Entirely generated from `STRATEGIES`. The grid is a map of the problem space rather than a
 *   menu of features - most of these tiles describe work that has not been built yet, and say so.
 */

import { Link } from 'react-router-dom'

import { STRATEGIES, type Strategy } from '../strategies/registry'

/** The quantities the detection work targets, from the project brief. */
const TARGETS = ['Doors', 'Detail markers', 'Elevation markers', 'Electrical receptacles']

/**
 * Render one strategy tile.
 *
 * Parameters:
 *   strategy: the registry entry to render.
 * Returns:
 *   A square card linking to the strategy's page.
 * Raises:
 *   Nothing.
 * Summary:
 *   The `ready` variant is styled distinctly so the one working tile is obvious in a grid of
 *   planned ones.
 */
function StrategyCard({ strategy }: { strategy: Strategy }) {
  const ready = strategy.status === 'ready'
  return (
    <Link
      to={strategy.href}
      className={'strategy-card' + (ready ? ' strategy-card--ready' : '')}
      aria-label={`${strategy.name}: ${strategy.tagline}`}
    >
      <div className="strategy-card__top">
        <span className="strategy-card__glyph" aria-hidden="true">
          {strategy.glyph}
        </span>
        <span className={'status-pill status-pill--' + strategy.status}>
          {ready ? 'Ready' : 'Planned'}
        </span>
      </div>
      <h3 className="strategy-card__name">{strategy.name}</h3>
      <p className="strategy-card__tagline">{strategy.tagline}</p>
      <div className="strategy-card__foot">
        <span>{strategy.cost}</span>
        <span className="strategy-card__cta">{ready ? 'Open →' : 'Read →'}</span>
      </div>
    </Link>
  )
}

/**
 * Render the home page.
 *
 * Parameters:
 *   None.
 * Returns:
 *   The page element.
 * Raises:
 *   Nothing.
 * Summary:
 *   Centred title block over the strategy grid, per the brief.
 */
export function HomePage() {
  return (
    <main className="home">
      <div className="home__hero">
        <span className="home__eyebrow">One-shot detection</span>
        <h1 className="home__title">Count anything on a drawing.</h1>
        <p className="home__subtitle">
          Draw a box around a single symbol on a rasterized construction drawing, and find every
          other instance of it on the sheet. Each tile below is a different way to solve that
          problem.
        </p>
        <div className="home__targets">
          {TARGETS.map((target) => (
            <span className="home__target" key={target}>
              {target}
            </span>
          ))}
        </div>
      </div>

      <p className="section-label">Strategies</p>
      <div className="strategy-grid">
        {STRATEGIES.map((strategy) => (
          <StrategyCard strategy={strategy} key={strategy.id} />
        ))}
      </div>
    </main>
  )
}
