DATA CHARTS — when an idea is backed by REAL NUMBERS, draw the numbers, not a metaphor. Pick by GOAL (the chart's main statement is the compass; once the goal is known, most chart types can simply be ignored):

CHANGE OVER TIME
- chart_line: the default for a value moving across months or years, up to 5 series. More than ~5 overlapping lines is spaghetti — use chart_multiples.
- chart_multiples: many series, one mini panel each, ONE shared scale.
- chart_area: how a total's internal breakdown shifted over time (mode "share" for a 100% view). Composition is the story, not precise values.
- chart_column: only a FEW points in time. Many periods → chart_line.
- chart_slope: only the first and last point across categories, when the wiggles between are not the story.
- chart_arrow: compact before→after for many categories.

SHARES OF A WHOLE
- chart_bar: percentages compare better as bars than as pie slices — a 3-point gap is visible in a bar and invisible in a pie. The DEFAULT for shares.
- chart_pie: only a simple, obvious split (2-4 slices, one dominant); donut mode carries a centre stat.
- chart_waffle: an illustrative of-100 share; trades precision for warmth.
- chart_treemap: proportions across MANY categories (up to ~12).
- chart_marimekko: shares AND absolute size at once (column width = size).
- chart_bar_stacked mode "share": survey / Likert rows.

AMOUNTS
- chart_bar: the workhorse — sorted, direct-labelled.
- chart_bar_grouped: 2-3 values compared within each category.
- chart_bar_stacked mode "absolute": totals split into parts.
- chart_bar_split: two components mirrored (in/out, population pyramids).
- chart_dot: several values per category in little space.
- chart_prop_area: 2-4 magnitudes as area-true shapes — impact over precision.
- bigstat (diagram): when ONE number IS the story, print it huge instead of charting it.

RELATIONSHIPS
- chart_scatter: does X relate to Y? Label only points worth naming; size makes it a bubble chart (area-true).
- chart_heatmap: a matrix of intensity (day × time, category × stage); also the fix for an unreadable dot cloud.

FLOWS
- chart_sankey: volume flowing source → destination (money, leads, energy).

CHART RULES (the renderer enforces the hard ones):
- Bars, columns, areas and waffles always start at zero; lines may zoom.
- Direct labels beat legends — the templates label line ends and bar ends themselves.
- NEVER invent numbers. Chart templates are ONLY for real figures present in the article or supplied by the operator. If the text gestures at magnitude without numbers, use a diagram (story shape) instead.
- Familiar beats fancy for a mainstream audience; one less-common shape can wake up a chart-heavy piece.
- Small screens: prefer bars (grow down) over columns (grow right).
- GEO MAPS (choropleth, symbol, locator) are NOT renderable here: use chart_bar or chart_heatmap by region instead.
