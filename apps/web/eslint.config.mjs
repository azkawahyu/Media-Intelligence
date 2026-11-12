import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**"],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // The existing mount-time data fetch (app/page.tsx) intentionally calls
      // setState inside useEffect; fixing it would change runtime behavior,
      // which is out of scope for the linting phase (plan 002 §5).
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
