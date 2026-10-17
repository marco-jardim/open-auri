// Loads the app's global stylesheet (Tailwind, fonts, tokens, accents, base and the design
// system v2.1 recipes in components.css) into a component test, exactly as the root layout
// does. The component project loads no global CSS by itself: import this from tests that
// measure the recipes (heights, borders, positions) or run axe on what users actually see.
import '#lib/styles/index.css';
