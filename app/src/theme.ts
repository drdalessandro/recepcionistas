import { createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * Paleta de marca Biowellness: cobre/bronce sobre crema cálida (identidad del
 * logo). `bio` es el color primario; `cafe` es el marrón oscuro para textos/acentos.
 */
const bio: MantineColorsTuple = [
  '#fbf3eb',
  '#efddcc',
  '#e3bfa1',
  '#d7a074',
  '#cd8752',
  '#c7743c',
  '#b5652f', // 6 — cobre de marca (relleno de botones en claro)
  '#8f4f25',
  '#6d3d1f',
  '#4e2c16',
];

const cafe: MantineColorsTuple = [
  '#f6f1ee',
  '#e3d8d1',
  '#cbbaae',
  '#b39a8a',
  '#9f826f',
  '#93745f',
  '#6f5340',
  '#523d2f',
  '#3a2a20',
  '#241813',
];

/** Tema amable para recepción: tipografía grande, botones cómodos, look cobre/marrón. */
export const theme = createTheme({
  primaryColor: 'bio',
  primaryShade: { light: 6, dark: 5 },
  autoContrast: true,
  luminanceThreshold: 0.35,
  defaultRadius: 'md',
  colors: { bio, cafe },
  fontSizes: {
    md: '1rem',
    lg: '1.125rem',
  },
  components: {
    Button: {
      defaultProps: { size: 'md' },
    },
  },
});
