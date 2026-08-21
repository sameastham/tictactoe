import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "legacy/**",
      "drizzle/**",
      "data/**",
      ".tmp/**",
      // Generated native Android project (Gradle/Capacitor build output,
      // bundled web-runtime JS) — not app source, never hand-edited.
      "android/**",
    ],
  },
];

export default eslintConfig;
