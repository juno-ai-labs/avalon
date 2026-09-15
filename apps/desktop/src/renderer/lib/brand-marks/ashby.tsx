import { forwardRef, type SVGProps } from 'react';

/**
 * Ashby's product icon: the serif A punched from the rounded square at
 * https://www.ashbyhq.com/favicon.png. The stacked marketing lockup at
 * Ashby-Logo.svg is a different glyph plus a wordmark; it is not the mark
 * people know the product by. `@thesvg/react` has no `ashby` slug; this is
 * the company's art drawn the same way as a catalogued brand: `currentColor`,
 * through `ConnectorMark`. The A is a hole so `.connector-mark`'s CSS fill
 * cannot paint letter and field the same colour. Identifying the connector
 * is ordinary brand-use.
 */
export type AshbyProps = SVGProps<SVGSVGElement> & { variant?: 'mono' };

const Ashby = forwardRef<SVGSVGElement, AshbyProps>(function Ashby(props, ref) {
  const { variant, ...rest } = props;
  void variant;
  return (
    <svg
      ref={ref}
      viewBox="0 0 192 192"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <title>Ashby</title>
      <path
        fillRule="evenodd"
        d="M8 0 H184 A8 8 0 0 1 192 8 V184 A8 8 0 0 1 184 192 H8 A8 8 0 0 1 0 184 V8 A8 8 0 0 1 8 0 Z M67.1 87.2 c-10.7 29.9 -20.5 56.4 -21.8 59 c-2.6 5.4 -4.9 7 -11.3 7.8 c-3.7 0.4 -4.6 0.9 -4.8 2.7 c-0.3 2.3 -0.3 2.3 19.7 2.3 c20.1 0 20.1 0 20.1 -2.5 c0 -2.4 -0.3 -2.5 -5.3 -2.5 c-6.4 0 -9.7 -2 -9.6 -5.8 c0 -1.5 2.6 -10.1 5.7 -19.2 c5.8 -16.5 5.8 -16.5 23.2 -16.5 c17.4 0 17.4 0 24.2 17.5 c3.7 9.6 6.7 18.5 6.7 19.7 c0.1 2.9 -1.3 3.7 -7.9 4.3 c-4.8 0.4 -5.5 0.8 -5.8 2.8 c-0.3 2.2 -0.3 2.2 31.2 2.2 c31.6 0 31.6 0 31.6 -2.5 c0 -2.2 -0.4 -2.5 -3.4 -2.5 c-1.8 0 -4.5 -0.9 -5.9 -2 c-2.6 -2.1 -3.9 -5.1 -38.7 -93.3 c-10.1 -25.7 -10.1 -25.7 -19.3 -25.7 c-9.3 0 -9.3 0 -28.6 54.2 Z m23 -1.5 c7.6 19.8 7.6 19.8 -6.9 20.1 c-8 0.1 -14.6 0.1 -14.8 -0.1 c-0.2 -0.2 2.6 -8.7 6.1 -18.9 c3.6 -10.3 6.5 -19.2 6.5 -19.7 c0 -3.7 2.4 1.2 9.1 18.6 Z"
      />
    </svg>
  );
});

Ashby.displayName = 'Ashby';

export default Ashby;
