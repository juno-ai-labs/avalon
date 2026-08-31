interface MermaidThemeConfig {
  themeCSS: string;
  themeVariables: Record<string, boolean | number | string>;
}

type TokenReader = (customProperty: string) => string;

function readRootToken(customProperty: string): string {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(customProperty).trim();
  if (!value) throw new Error('mermaid_theme_token_missing');
  return value;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error('mermaid_theme_measurement_invalid');
  return parsed;
}

/**
 * Mermaid has to receive concrete colours before it generates its SVG styles,
 * so this third-party boundary resolves Rally's active custom properties once
 * per render. No palette or appearance choice lives here: every value comes
 * from the same semantic tokens used by the surrounding Markdown surface.
 */
export function readMermaidThemeConfig(readUnvalidatedToken: TokenReader = readRootToken): MermaidThemeConfig {
  const readToken = (customProperty: string): string => {
    const value = readUnvalidatedToken(customProperty).trim();
    if (!value) throw new Error('mermaid_theme_token_missing');
    return value;
  };
  const surfaceSubtle = readToken('--av-sys-color-surface-subtle');
  const surfaceSunken = readToken('--av-sys-color-surface-sunken');
  const surfaceRaised = readToken('--av-sys-color-surface-raised');
  const surfaceRaisedHover = readToken('--av-sys-color-surface-raised-hover');
  const surfaceElevated = readToken('--av-sys-color-surface-elevated');
  const textOnInverse = readToken('--av-sys-color-text-on-inverse');
  const textDefault = readToken('--av-sys-color-text-default');
  const textSubtle = readToken('--av-sys-color-text-subtle');
  const textMuted = readToken('--av-sys-color-text-muted');
  const textDisabled = readToken('--av-sys-color-text-disabled');
  const borderDefault = readToken('--av-sys-color-border-default');
  const borderSubtle = readToken('--av-sys-color-border-subtle');
  const diagramLine = readToken('--av-cmp-markdown-diagram-line');
  const brandBase = readToken('--av-sys-color-brand-base');
  const brandWash = readToken('--av-sys-color-brand-wash');
  const brandEdge = readToken('--av-sys-color-brand-edge');
  const accentBase = readToken('--av-sys-color-accent-base');
  const accentSoft = readToken('--av-sys-color-accent-soft');
  const accentWash = readToken('--av-sys-color-accent-wash');
  const accentEdge = readToken('--av-sys-color-accent-edge');
  const accentOn = readToken('--av-sys-color-accent-on');
  const successBase = readToken('--av-sys-color-success-base');
  const successWash = readToken('--av-sys-color-success-wash');
  const successEdge = readToken('--av-sys-color-success-edge');
  const warningBase = readToken('--av-sys-color-warning-base');
  const warningWash = readToken('--av-sys-color-warning-wash');
  const warningEdge = readToken('--av-sys-color-warning-edge');
  const dangerBase = readToken('--av-sys-color-danger-base');
  const dangerSoft = readToken('--av-sys-color-danger-soft');
  const dangerWash = readToken('--av-sys-color-danger-wash');
  const dangerEdge = readToken('--av-sys-color-danger-edge');
  const fontFamily = readToken('--av-sys-font-family-ui');
  const fontSize = readToken('--av-sys-font-size-prose');
  const fontWeight = readToken('--av-sys-font-weight-strong');
  const radius = pixels(readToken('--av-sys-size-radius-md'));
  const strokeWidth = pixels(readToken('--av-sys-size-border-hairline'));

  const themeVariables: Record<string, boolean | number | string> = {
    background: surfaceRaised,
    primaryColor: surfaceElevated,
    primaryTextColor: textDefault,
    primaryBorderColor: borderDefault,
    secondaryColor: accentWash,
    secondaryTextColor: textDefault,
    secondaryBorderColor: accentEdge,
    tertiaryColor: surfaceSubtle,
    tertiaryTextColor: textSubtle,
    tertiaryBorderColor: borderSubtle,
    lineColor: diagramLine,
    arrowheadColor: diagramLine,
    textColor: textDefault,
    titleColor: textDefault,
    nodeBkg: surfaceElevated,
    mainBkg: surfaceElevated,
    nodeBorder: borderDefault,
    nodeTextColor: textDefault,
    clusterBkg: surfaceSubtle,
    clusterBorder: borderSubtle,
    defaultLinkColor: diagramLine,
    edgeLabelBackground: surfaceRaised,
    noteBkgColor: warningWash,
    noteBorderColor: warningEdge,
    noteTextColor: textDefault,
    actorBkg: surfaceElevated,
    actorBorder: borderDefault,
    actorTextColor: textDefault,
    actorLineColor: borderSubtle,
    signalColor: diagramLine,
    signalTextColor: textDefault,
    labelBoxBkgColor: accentWash,
    labelBoxBorderColor: accentEdge,
    labelTextColor: textDefault,
    loopTextColor: textSubtle,
    activationBkgColor: accentWash,
    activationBorderColor: accentEdge,
    sequenceNumberColor: accentBase,
    rectBkgColor: accentWash,
    sectionBkgColor: surfaceSubtle,
    altSectionBkgColor: surfaceRaised,
    sectionBkgColor2: surfaceSunken,
    excludeBkgColor: dangerWash,
    taskBkgColor: surfaceElevated,
    taskBorderColor: borderDefault,
    activeTaskBkgColor: accentWash,
    activeTaskBorderColor: accentEdge,
    doneTaskBkgColor: successWash,
    doneTaskBorderColor: successEdge,
    critBkgColor: dangerWash,
    critBorderColor: dangerEdge,
    todayLineColor: warningBase,
    gridColor: borderSubtle,
    vertLineColor: borderSubtle,
    taskTextColor: textDefault,
    taskTextOutsideColor: textDefault,
    taskTextLightColor: textOnInverse,
    taskTextDarkColor: textDefault,
    taskTextClickableColor: accentSoft,
    personBkg: surfaceElevated,
    personBorder: borderDefault,
    rowOdd: surfaceRaised,
    rowEven: surfaceSubtle,
    transitionColor: diagramLine,
    transitionLabelColor: textDefault,
    stateLabelColor: textDefault,
    stateBkg: surfaceElevated,
    labelBackgroundColor: surfaceRaised,
    compositeBackground: surfaceSubtle,
    altBackground: surfaceSunken,
    compositeTitleBackground: surfaceRaisedHover,
    compositeBorder: borderDefault,
    innerEndBackground: textDefault,
    errorBkgColor: dangerWash,
    errorTextColor: dangerSoft,
    specialStateColor: warningBase,
    classText: textDefault,
    scaleLabelColor: textDefault,
    pieTitleTextColor: textDefault,
    pieSectionTextColor: textDefault,
    pieLegendTextColor: textSubtle,
    pieStrokeColor: surfaceRaised,
    pieOuterStrokeColor: borderSubtle,
    vennTitleTextColor: textDefault,
    vennSetTextColor: textDefault,
    quadrant1Fill: accentWash,
    quadrant2Fill: successWash,
    quadrant3Fill: warningWash,
    quadrant4Fill: dangerWash,
    quadrant1TextFill: textDefault,
    quadrant2TextFill: textDefault,
    quadrant3TextFill: textDefault,
    quadrant4TextFill: textDefault,
    quadrantPointFill: accentBase,
    quadrantPointTextFill: accentOn,
    quadrantXAxisTextFill: textMuted,
    quadrantYAxisTextFill: textMuted,
    quadrantInternalBorderStrokeFill: borderSubtle,
    quadrantExternalBorderStrokeFill: borderDefault,
    quadrantTitleFill: textDefault,
    requirementBackground: surfaceElevated,
    requirementBorderColor: borderDefault,
    requirementTextColor: textDefault,
    relationColor: diagramLine,
    relationLabelBackground: surfaceRaised,
    relationLabelColor: textDefault,
    branchLabelColor: textDefault,
    tagLabelColor: textDefault,
    tagLabelBackground: warningWash,
    tagLabelBorder: warningEdge,
    commitLabelColor: textDefault,
    commitLabelBackground: surfaceRaised,
    archEdgeColor: diagramLine,
    archEdgeArrowColor: diagramLine,
    archGroupBorderColor: borderSubtle,
    fontFamily,
    fontSize,
    fontWeight,
    radius,
    strokeWidth,
    useGradient: false,
  };

  const seriesFills = [
    brandWash, accentWash, successWash, warningWash, dangerWash, surfaceSunken,
    brandEdge, accentEdge, successEdge, warningEdge, dangerEdge, surfaceRaisedHover,
  ];
  const seriesLines = [
    brandBase, accentBase, successBase, warningBase, dangerBase, diagramLine,
    brandBase, accentBase, successBase, warningBase, dangerBase, textDisabled,
  ];
  for (let index = 0; index < seriesFills.length; index += 1) {
    themeVariables[`cScale${index}`] = seriesFills[index]!;
    themeVariables[`cScaleInv${index}`] = seriesLines[index]!;
    themeVariables[`pie${index + 1}`] = seriesFills[index]!;
    if (index < 8) {
      themeVariables[`fillType${index}`] = seriesFills[index]!;
      themeVariables[`git${index}`] = seriesFills[index]!;
      themeVariables[`gitInv${index}`] = seriesLines[index]!;
      themeVariables[`gitBranchLabel${index}`] = textDefault;
    }
  }

  return {
    // Mermaid uses signalColor for both sequence lines and number labels. The
    // label needs the token intended for text on the accent fill instead.
    themeCSS: `[id$="-sequencenumber"] { fill: ${accentOn} !important; }`,
    themeVariables,
  };
}
