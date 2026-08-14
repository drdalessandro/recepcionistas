/**
 * Texto del Consentimiento Informado de BIOWELLNESS (Shanti Om SRL) — FUENTE DE VERDAD.
 *
 * Vivía solo en el portal (`portal/src/pages/health-record/InformedConsent.data.ts`).
 * Se trae acá porque este repo es el que tiene el seed: el texto se publica como
 * recurso FHIR (`Library`, versionado) y **las dos apps lo leen de ahí** — el
 * portal y el kiosco del mostrador. Un documento legal no puede tener dos
 * versiones distintas según por dónde entró el paciente.
 *
 * El contenido se copió BYTE A BYTE del original; no se reescribió una coma.
 * Todo cambio de fondo del texto lo aprueba el Director Médico y sube la
 * `VERSION_CONSENTIMIENTO` (las firmas viejas siguen siendo válidas para su
 * versión; ver `policyRule.text` del Consent).
 */

/** Versión del texto firmado. Viaja en el Consent y en el documento. */
export const VERSION_CONSENTIMIENTO = 'v1';

/** URL canónica del Library que publica este texto (contrato con el portal). */
export const CONSENTIMIENTO_LIBRARY_URL = 'https://biowellness.ar/Library/consentimiento-informado';

export type ConsentBlock =
  | { readonly type: 'p'; readonly text: string }
  | { readonly type: 'sub'; readonly text: string }
  | { readonly type: 'ul'; readonly items: string[] };

export interface ConsentSection {
  readonly heading: string;
  readonly blocks: ConsentBlock[];
}

export const consentTitle = 'Consentimiento Informado';
export const consentSubtitle = 'Válido para todos los protocolos y terapias ofrecidos en BIOWELLNESS';

export const consentSections: ConsentSection[] = [
  {
    heading: '2. Descripción de los servicios',
    blocks: [
      {
        type: 'p',
        text: 'BIOWELLNESS es un centro de optimización biológica que ofrece protocolos orientados a la recuperación, el rendimiento y el bienestar integral. Los servicios incluidos en este consentimiento son:',
      },
      {
        type: 'ul',
        items: [
          'Oxigenoterapia Hiperbárica (HBOT): exposición a oxígeno comprimido en cámara monoplaza o multiplaza.',
          'Entrenamiento Hipóxico-Hiperóxico Intermitente (IHHT): protocolos de alternancia entre aire hipóxico e hiperóxico para estimulación mitocondrial.',
          'Fototerapia de luz roja / fotobiomodulación: exposición a longitudes de onda de luz roja e infrarroja cercana.',
          'Terapia de contraste: sauna finlandesa (hasta 80 °C) seguida de inmersión en agua fría (4 °C).',
          'Terapias biológicas: aplicación de sueros endovenosos, PRP, péptidos, exosomas y células madre (requieren evaluación previa del Director Médico).',
          'Botas de compresión y recuperación: sistema neumático de compresión secuencial con crioterapia integrada.',
          'Masajes deportivos y terapéuticos.',
          'Yoga, meditación y mindfulness.',
          'Barra de alimentación saludable.',
        ],
      },
      {
        type: 'p',
        text: 'Cada sesión es supervisada por personal capacitado. Las terapias biológicas (ítem 5) requieren adicionalmente una evaluación médica previa con el Director Médico de BIOWELLNESS.',
      },
    ],
  },
  {
    heading: '3. Declaración de estado de salud',
    blocks: [
      {
        type: 'p',
        text: 'Declaro que he informado verazmente a BIOWELLNESS sobre mi estado de salud actual. En particular, declaro que:',
      },
      {
        type: 'ul',
        items: [
          'No padezco ninguna de las contraindicaciones absolutas detalladas en la sección 4 de este documento.',
          'He informado sobre todas las condiciones médicas, cirugías recientes, medicamentos que consumo (incluyendo suplementos y anticoagulantes) y alergias conocidas.',
          'En caso de embarazo, lo he comunicado expresamente al staff de BIOWELLNESS antes de iniciar cualquier protocolo.',
          'No me encuentro bajo los efectos de alcohol, drogas ni medicamentos que alteren la conciencia o el equilibrio.',
          'He consultado con mi médico tratante en caso de padecer enfermedades cardiovasculares, respiratorias, neurológicas, oncológicas o cualquier condición crónica relevante.',
        ],
      },
      {
        type: 'p',
        text: 'Entiendo que la veracidad de esta declaración es mi responsabilidad y que la omisión de información puede generar riesgos para mi salud, eximiendo a BIOWELLNESS y a su personal de responsabilidad ante dichos eventos.',
      },
    ],
  },
  {
    heading: '4. Contraindicaciones absolutas y relativas',
    blocks: [
      {
        type: 'p',
        text: 'Las siguientes condiciones constituyen contraindicaciones absolutas para uno o más de los servicios de BIOWELLNESS. Declaro no presentar ninguna de las siguientes sin haber informado al staff:',
      },
      { type: 'sub', text: 'Contraindicaciones absolutas (HBOT y cámara hiperbárica):' },
      {
        type: 'ul',
        items: [
          'Neumotórax no tratado.',
          'Infección respiratoria alta aguda (resfríos, sinusitis, otitis).',
          'Cirugía de oído, nariz o tórax en los últimos 30 días sin autorización médica.',
          'Marcapasos o implantes electrónicos no certificados para uso hiperbárico.',
          'Claustrofobia severa no controlada.',
          'Convulsiones no controladas.',
        ],
      },
      { type: 'sub', text: 'Contraindicaciones absolutas (IHHT):' },
      {
        type: 'ul',
        items: [
          'Insuficiencia cardíaca descompensada o infarto agudo reciente (menos de 6 meses).',
          'Presión arterial no controlada (>180/110 mmHg).',
          'Enfermedad pulmonar obstructiva severa (EPOC estadio IV).',
          'Trombosis venosa profunda activa.',
        ],
      },
      { type: 'sub', text: 'Contraindicaciones absolutas (terapia de contraste / sauna + cold plunge):' },
      {
        type: 'ul',
        items: [
          'Enfermedades cardiovasculares graves no estabilizadas.',
          'Raynaud severo u otras alteraciones vasculares periféricas severas.',
          'Epilepsia no controlada.',
        ],
      },
      {
        type: 'p',
        text: 'Las condiciones relativas serán evaluadas caso a caso por el staff o el Director Médico. Ante cualquier duda, deberá realizarse una evaluación médica previa antes de iniciar el protocolo.',
      },
    ],
  },
  {
    heading: '5. Riesgos y efectos adversos posibles',
    blocks: [
      {
        type: 'p',
        text: 'He sido informado/a de que los servicios de BIOWELLNESS, si bien son seguros dentro de los protocolos establecidos, pueden presentar efectos adversos en algunos casos, entre ellos:',
      },
      {
        type: 'ul',
        items: [
          'HBOT: molestia o dolor en oídos (barotrauma ótico) durante la presurización o despresurización; sensación de presión nasal; cansancio post-sesión.',
          'IHHT: mareos, cefalea leve o fatiga transitoria durante los ciclos hipóxicos; palpitaciones.',
          'Fototerapia: sensibilidad ocular si no se utilizan los protectores provistos; raramente, irritación cutánea en pieles muy sensibles.',
          'Terapia de contraste: hipotermia leve, mareos o lipotimia si no se respetan los tiempos indicados; reacción vagal ante la inmersión en frío.',
          'Botas de compresión: incomodidad por presión; contraindicadas ante trombosis activa no diagnosticada.',
          'Terapias biológicas: reacciones locales en el sitio de aplicación, hematoma, infección; raramente, reacciones alérgicas sistémicas.',
        ],
      },
      {
        type: 'p',
        text: 'Declaro haber recibido explicación suficiente sobre estos riesgos y acepto asumir voluntariamente dichas posibilidades dentro de los márgenes normales de la práctica.',
      },
    ],
  },
  {
    heading: '6. Normas de conducta y seguridad',
    blocks: [
      { type: 'p', text: 'Me comprometo a cumplir las siguientes normas durante mi estadía en BIOWELLNESS:' },
      {
        type: 'ul',
        items: [
          'Informar inmediatamente a cualquier operador del servicio si experimento malestar, dolor o síntomas inusuales durante una sesión.',
          'No ingresar a la cámara hiperbárica con: relojes, celulares, encendedores, aerosoles, cosméticos, maquillaje, ropa sintética (nylon, lycra, poliéster), abrigos o calzado.',
          'No ingresar a las instalaciones bajo efectos de alcohol o sustancias psicoactivas.',
          'Respetar los tiempos de sesión indicados por el operador; no extender ni interrumpir los protocolos sin comunicarlo.',
          'Hidratarme adecuadamente antes y después de cada sesión según las indicaciones del staff.',
          'No utilizar los equipos de forma autónoma sin supervisión del personal de BIOWELLNESS.',
          'Consultar sobre mis prótesis o implantes antes de ingresar a cualquier dispositivo electromagnético.',
          'En caso de menores de edad, el acompañante adulto responsable es quien firma este consentimiento y asume plena responsabilidad.',
        ],
      },
    ],
  },
  {
    heading: '7. Privacidad y tratamiento de datos personales',
    blocks: [
      {
        type: 'p',
        text: 'De conformidad con la Ley N° 25.326 de Protección de Datos Personales, BIOWELLNESS (Shanti Om SRL) se compromete a:',
      },
      {
        type: 'ul',
        items: [
          'Tratar los datos personales y de salud del cliente con carácter confidencial y únicamente para la gestión de sus servicios.',
          'No ceder, vender ni compartir la información personal del cliente con terceros, salvo requerimiento judicial o autorización expresa.',
          'Garantizar al titular el acceso, rectificación y supresión de sus datos mediante solicitud escrita a info@biowellness.ar.',
        ],
      },
      {
        type: 'p',
        text: 'El cliente autoriza a BIOWELLNESS a registrar y conservar los datos de salud provistos en este formulario en su legajo personal, con acceso restringido al Director Médico y al personal autorizado.',
      },
    ],
  },
  {
    heading: '8. Declaración final y consentimiento',
    blocks: [
      { type: 'p', text: 'Yo, el/la abajo firmante, declaro que:' },
      {
        type: 'ul',
        items: [
          'He leído y comprendido completamente el contenido de este documento.',
          'He tenido la oportunidad de realizar preguntas y todas han sido respondidas satisfactoriamente.',
          'Consiento libre y voluntariamente recibir los servicios de BIOWELLNESS, habiendo sido informado/a de sus características, beneficios, riesgos y contraindicaciones.',
          'La información declarada sobre mi estado de salud es completa y veraz.',
          'Entiendo que puedo revocar este consentimiento en cualquier momento, lo cual implicará la interrupción del servicio, sin afectar mis derechos como usuario.',
        ],
      },
    ],
  },
];

export const consentFooter =
  'BIOWELLNESS — Shanti Om SRL  |  Roque Sáenz Peña 530, San Isidro, Buenos Aires  |  info@biowellness.ar';
