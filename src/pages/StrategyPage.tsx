/**
 * A single strategy's write-up, and the button that will one day run it.
 *
 * Summary:
 *   Rendered from the registry, so this one component serves every planned strategy. The Run
 *   control is deliberately present and disabled rather than absent: it names the exact function
 *   a future implementation has to satisfy, which is more useful than a blank page.
 */

import { Link, useParams } from 'react-router-dom'

import { getStrategy } from '../strategies/registry'

/**
 * Render the strategy detail page.
 *
 * Parameters:
 *   None; the strategy id comes from the `:id` route parameter.
 * Returns:
 *   The page element, or a not-found message for an unknown id.
 * Raises:
 *   Nothing.
 * Summary:
 *   Lists the mechanism in execution order alongside an honest account of what the approach
 *   costs, so the tiles can be compared rather than just admired.
 */
export function StrategyPage() {
  const { id } = useParams<{ id: string }>()
  const strategy = getStrategy(id)

  if (!strategy) {
    return (
      <main className="detail">
        <h1 className="detail__title">Unknown strategy</h1>
        <p className="detail__lede">
          There is no strategy called <code>{id}</code>. <Link to="/">Back to the strategies</Link>.
        </p>
      </main>
    )
  }

  return (
    <main className="detail">
      <div className="detail__head">
        <span className="detail__glyph" aria-hidden="true">
          {strategy.glyph}
        </span>
        <div>
          <h1 className="detail__title">{strategy.name}</h1>
          <span className={'status-pill status-pill--' + strategy.status}>
            {strategy.status === 'ready' ? 'Ready' : 'Planned'}
          </span>
        </div>
      </div>

      <p className="detail__lede">{strategy.description}</p>

      <section className="detail__section">
        <h2>How it runs</h2>
        <ol className="detail__steps">
          {strategy.approach.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="detail__section detail__columns">
        <div>
          <h2>Strengths</h2>
          <ul className="detail__list">
            {strategy.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Risks</h2>
          <ul className="detail__list detail__list--risks">
            {strategy.risks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="detail__section">
        <h2>Cost per sheet</h2>
        <p className="detail__lede" style={{ marginTop: 0, fontSize: '15px' }}>
          {strategy.cost}
        </p>
      </section>

      <div className="detail__runbar">
        <p>
          {strategy.status === 'ready' ? (
            <>Open the workspace to draw an exemplar on any sheet in the library.</>
          ) : (
            <>
              No implementation yet. When one exists it plugs into{' '}
              <code>runStrategy()</code> in <code>src/api/detect.ts</code> and needs no UI changes.
              The design is written up in <code>FUTURE_WORK.md</code>.
            </>
          )}
        </p>
        {strategy.status === 'ready' ? (
          <Link to={strategy.href} className="button button--primary">
            Open workspace
          </Link>
        ) : (
          <button type="button" className="button" disabled title="No backend for this strategy yet">
            Run strategy
          </button>
        )}
      </div>
    </main>
  )
}
