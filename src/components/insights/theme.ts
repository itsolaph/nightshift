// Custom AG Studio theme: the Almanac ledger (slate stock, pale sheet, blue-black ink, one magenta).
// Charts draw on canvas, which cannot read CSS variables, so the values here are tokens.css
// converted to sRGB hex. Keep the two in step.

import { studioTheme } from "ag-studio";

const T = {
  paper: "#c4cbd2", // --color-paper
  paper2: "#bbc2c8", // --color-paper-2
  sheet: "#e5eaef", // --color-sheet
  ink: "#060e15", // --color-ink
  ink2: "#182027", // --color-ink-2
  muted: "#3b434b", // --color-muted
  rule: "#a1a9af", // --color-rule
  rule2: "#2b343b", // --color-rule-2
  accent: "#970d63", // --color-accent
};

// One series argues in magenta; the rest step down a slate ramp so a stacked or grouped chart
// stays readable without a second hue.
const PALETTE = [T.accent, T.ink2, "#68737d", "#86919a", T.muted, "#a1a9af", "#4f5a63", "#7a858e", "#2b343b", "#949fa8"];

const palette = Object.fromEntries(
  PALETTE.flatMap((color, i) => [
    [`chartPaletteFills${i + 1}Color`, color],
    [`chartPaletteStrokes${i + 1}Color`, color],
  ]),
);

const BODY = 'var(--font-newsreader), "Newsreader", ui-serif, Georgia, serif';
const DISPLAY = 'var(--font-hanken), "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif';
// Canvas text cannot resolve var(); the chart face names the loaded family directly.
const CHART = '"IBM Plex Mono", ui-monospace, monospace';

export const nightshiftStudioTheme = studioTheme.withParams({
  browserColorScheme: "light",
  fontFamily: BODY,
  fontSize: 14,
  backgroundColor: T.sheet,
  foregroundColor: T.ink,
  textColor: T.ink,
  subtleTextColor: T.muted,
  borderColor: T.rule,
  accentColor: T.accent,
  iconColor: T.muted,
  rowHoverColor: T.paper2,
  menuBackgroundColor: T.sheet,
  tooltipBackgroundColor: T.ink,
  tooltipTextColor: T.sheet,

  studioWrapperBackgroundColor: T.paper,
  studioCanvasBackgroundColor: T.paper,
  studioPanelContainerBackgroundColor: T.sheet,
  studioWidgetBackgroundColor: T.sheet,
  studioWidgetBorder: { width: 1, color: T.rule },
  studioWidgetBorderRadius: 0,
  studioWidgetTitleTextColor: T.ink,
  studioWidgetTitleFontFamily: DISPLAY,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
  // The canvas face sets the value widgets, which are figures; it is measured, so it takes the family name.
  studioCanvasFontFamily: CHART,
  studioValueWidgetFontSize: 30,
  // Three weights across the app: 400 and 500 for text and figures, 600 for heads.
  buttonFontWeight: 500,
  gridHeaderFontWeight: 500,
  studioPanelHeaderFontWeight: 600,
  studioFormLabelFontWeight: 500,
  studioWidgetSubtitleFontWeight: 400,
  studioWidgetCaptionFontWeight: 400,
  chartFontFamily: CHART,
  studioWidgetSubtitleTextColor: T.muted,

  gridHeaderBackgroundColor: T.sheet,
  gridHeaderTextColor: T.muted,
  gridOddRowBackgroundColor: T.sheet,
  gridCellTextColor: T.ink,
  gridRowBorder: { width: 1, color: T.rule },

  chartTextColor: T.ink,
  chartSubtleTextColor: T.muted,
  chartAxisLineColor: T.rule2,
  chartGridLineColor: T.rule,
  chartTooltipBackgroundColor: T.ink,
  chartTooltipTextColor: T.sheet,
  ...palette,
});
