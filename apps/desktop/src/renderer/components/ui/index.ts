/**
 * The component library's public surface.
 *
 * App code imports from here and from nowhere else inside `ui/`. That is the
 * whole contract: while every call site names the barrel, the backing of any
 * one component can be replaced — a different headless library, a hand-written
 * element, a vendored kit — in one file, and the change reaches the product
 * without a single caller being edited. A screen that reaches past it for
 * `ui/button` gets that guarantee revoked, which is why the
 * `rally/component-library-barrel` ESLint rule fails the deep import.
 *
 * See `docs/component-library.md`.
 */

export { cn } from './cn';

export { Icon, iconNames, type IconName, type IconProps, type IconSize } from './icon';
export { ConnectorIcon, connectorNames, type ConnectorIconProps } from './connector-icon';

export { Button, buttonVariantNames, type ButtonProps, type ButtonVariant } from './button';
export { IconButton, type IconButtonProps } from './icon-button';

export { Input, Textarea, type InputProps, type TextareaProps } from './input';
export { Description, ErrorMessage, Field, Fieldset, Label, useFieldControl } from './field';
export { Switch, type SwitchProps } from './switch';
export { Select, type SelectOption, type SelectProps } from './select';

export { Dialog, type DialogProps } from './dialog';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export { Badge, badgeTones, type BadgeProps, type BadgeTone } from './badge';
export { Divider, type DividerProps } from './divider';
export { Code, Eyebrow, Heading, Kbd, Strong, Subheading, Text } from './text';
