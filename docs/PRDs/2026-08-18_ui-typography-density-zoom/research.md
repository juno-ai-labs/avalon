# Sizing, visual density, and magnification research

> Created 2026-08-18. Supporting research for [`prd.md`](prd.md).

## Academic & Ergonomic Findings

### 1. Vision Science & Visual Angle
* **Legge & Bigelow (2011)** (*Journal of Vision*): Demonstrated that reading speed is governed by **angular size (visual angle)** subtended at the retina, not absolute physical or nominal point size.
  * The **Critical Print Size (CPS)** threshold for fluent reading is approximately $0.2^\circ$ ($12\text{ arcminutes}$) of x-height. Below this point, reading speed drops drastically, saccadic fixations multiply, and cognitive strain increases.
  * Fluent, comfortable reading spans $0.2^\circ\text{ to }2.0^\circ$ ($12\text{ to }120\text{ arcmin}$).
* **ISO 9241-303 / ISO 9241-305 Ergonomic Standards**:
  * Absolute minimum character height: **$16\text{ minutes of arc}$**.
  * Recommended optimal character height for continuous visual work: **$20\text{ to }22\text{ minutes of arc}$**.

### 2. Physical Viewing Distance & Distance Scaling
* Standard desktop display viewing distance: $50\text{ to }70\text{ cm}$ ($\approx 20–28\text{ inches}$).
* Stepping back $1\text{ foot}$ ($+30\text{ cm}$) shifts the eye distance to $80\text{ to }100\text{ cm}$ ($\approx 32–40\text{ inches}$).
* Under standard display resolutions ($\approx 96–110\text{ PPI}$ logical rendering):
  * **$10\text{px}$ text at $60\text{ cm}$**: Subtends $\approx 14.3\text{ arcmin}$ (fails ISO minimum).
  * **$10\text{px}$ text at $90\text{ cm}$**: Subtends $\approx 9.5\text{ arcmin}$ (falls below critical reading threshold).
  * **$15.5\text{px}$ text at $60\text{ cm}$**: Subtends $\approx 22.2\text{ arcmin}$ (optimal ergonomic range).
  * **$15.5\text{px}$ text at $90\text{ cm}$**: Subtends $\approx 14.8\text{ arcmin}$ (remains legible when leaning back).

### 3. Visual Clutter & Display Density
* **Rosenholtz et al. (2005, 2007, MIT)** (*Feature Congestion & Visual Clutter*):
  * Visual clutter can be objectively measured by variability in luminance, chrominance, and edge orientation across a display.
  * When interfaces pack too many competing UI elements, badges, and icons into tight boundaries without clear visual chunking, peripheral vision fails to compress the display into digestible groups.
  * This induces cognitive overload, visual search latency, and scanning avoidance.
* **Tullis (1983, 1984)** (*The Formatting of Alphanumeric Displays*):
  * Optimal display density for information retrieval is between **$18\%\text{ and }25\%$** character fill.
  * Densities exceeding **$40\%\text{ to }50\%$** increase search time and error rates significantly.

### 4. Typographic Measure & Line Height
* **Bringhurst (1992); Nanavati & Bias (2005)**:
  * Optimal line length for sustained reading is **$50\text{ to }75\text{ characters per line (CPL)}$**, with $66\text{ CPL}$ as the ideal center.
  * Lines longer than $85\text{ CPL}$ cause tracking errors during return saccades.
* **WCAG 2.1 / 2.2 Success Criterion 1.4.12 (Text Spacing)**:
  * Line height (leading) should be at least **$1.5\times$** the font size.
  * Spacing following paragraphs should be at least **$2\times$** the font size.
