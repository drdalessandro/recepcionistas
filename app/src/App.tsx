import { useState } from 'react';
import { Center, Paper, Stack, Title, Text } from '@mantine/core';
import { SignInForm, useMedplumProfile } from '@medplum/react';
import { Shell, type Vista } from './components/Shell';
import { AgendaDelDia } from './pages/AgendaDelDia';
import { Solicitudes } from './pages/Solicitudes';
import { Duplicados } from './pages/Duplicados';
import { Mensajes } from './pages/Mensajes';
import { PlanesSesiones } from './pages/PlanesSesiones';
import { Atender } from './pages/Atender';
import { Reportes } from './pages/Reportes';

export function App(): JSX.Element {
  const profile = useMedplumProfile();
  const [vista, setVista] = useState<Vista>('agenda');
  // Paciente con el que entrar a "Atender" (p. ej. al tocar "Atender" en el panel de planes).
  const [atenderId, setAtenderId] = useState<string | null>(null);

  if (!profile) {
    return <Login />;
  }

  const irAtender = (pacienteId: string): void => {
    setAtenderId(pacienteId);
    setVista('atender');
  };

  return (
    <Shell vista={vista} onVista={setVista}>
      {vista === 'agenda' && <AgendaDelDia />}
      {vista === 'solicitudes' && <Solicitudes onAtender={irAtender} />}
      {vista === 'duplicados' && <Duplicados />}
      {vista === 'mensajes' && <Mensajes />}
      {vista === 'planes' && <PlanesSesiones onAtender={irAtender} />}
      {vista === 'atender' && <Atender pacienteInicialId={atenderId} onPacienteInicialCargado={() => setAtenderId(null)} />}
      {vista === 'reportes' && <Reportes />}
    </Shell>
  );
}

function Login(): JSX.Element {
  const googleClientId = import.meta.env.GOOGLE_CLIENT_ID || (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID || undefined;
  if (!googleClientId) {
    // Diagnóstico visible en DevTools: el botón de Google solo aparece si el
    // build se hizo con GOOGLE_CLIENT_ID en app/.env.
    console.warn('[Login] GOOGLE_CLIENT_ID no está en el build: no se muestra "Acceder con Google". Definilo en app/.env y rebuildeá.');
  }
  return (
    <Center mih="100vh" bg="bio.0">
      <Paper withBorder shadow="md" p="xl" radius="lg" w={420} bg="white">
        <Stack gap="md">
          <Stack gap={2} align="center">
            <Title order={2} c="bio.7">
              Biowellness
            </Title>
            <Text c="dimmed" size="sm">
              Recepción · San Isidro
            </Text>
          </Stack>
          <SignInForm onSuccess={() => undefined} googleClientId={googleClientId}>
            <Text ta="center" size="sm" c="dimmed">
              Ingresá con tu cuenta {googleClientId ? 'o con Google' : ''}
            </Text>
          </SignInForm>
        </Stack>
      </Paper>
    </Center>
  );
}
