import { forwardRef, type SVGProps } from 'react';

/**
 * Ashby's own mark, the stacked circle and quarter from
 * https://www.ashbyhq.com/Ashby-Logo.svg — the wordmark is dropped so the
 * glyph reads at connector size. `@thesvg/react` has no `ashby` slug; this is
 * the company's art drawn the same way as a catalogued brand: `currentColor`,
 * through `ConnectorMark`. Identifying the connector is ordinary brand-use.
 */
export type AshbyProps = SVGProps<SVGSVGElement> & { variant?: 'mono' };

const Ashby = forwardRef<SVGSVGElement, AshbyProps>(function Ashby(props, ref) {
  const { variant, ...rest } = props;
  void variant;
  return (
    <svg
      ref={ref}
      viewBox="0 0 23.261 48.76"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <title>Ashby</title>
      <path d="M23.261 12.418c0 6.351-5.148 11.5-11.5 11.5-6.35 0-11.5-5.149-11.5-11.5s5.15-11.5 11.5-11.5c6.352 0 11.5 5.149 11.5 11.5Z" />
      <path d="M21.761 48.76a.49.49 0 0 0 .495-.5A21.003 21.003 0 0 0 1.76 27.766a.491.491 0 0 0-.5.494v20a.5.5 0 0 0 .5.5h20Z" />
    </svg>
  );
});

Ashby.displayName = 'Ashby';

export default Ashby;
