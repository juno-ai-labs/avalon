import { forwardRef, type SVGProps } from 'react';

/**
 * Fireflies' own mark, the four geometric tiles from
 * https://fireflies.ai/images/logo.svg, flattened to `currentColor` and
 * without the 18%-opacity overlays that only read in the colour art.
 * `@thesvg/react` has no `fireflies` slug; this is the company's art drawn
 * the same way as a catalogued brand, through `ConnectorMark`. Identifying
 * the connector is ordinary brand-use.
 */
export type FirefliesProps = SVGProps<SVGSVGElement> & { variant?: 'mono' };

const Fireflies = forwardRef<SVGSVGElement, FirefliesProps>(function Fireflies(props, ref) {
  const { variant, ...rest } = props;
  void variant;
  return (
    <svg
      ref={ref}
      viewBox="0 0 48.446 48.808"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <title>Fireflies</title>
      <rect width="15.928" height="15.928" />
      <rect width="15.928" height="15.928" x="18.866" y="19.228" />
      <path d="M34.794 0H18.866v15.928H48.447v-2.276A13.653 13.653 0 0 0 34.794 0Z" />
      <path d="M0 19.229v15.928A13.653 13.653 0 0 0 13.653 48.808h2.275v-29.58Z" />
    </svg>
  );
});

Fireflies.displayName = 'Fireflies';

export default Fireflies;
