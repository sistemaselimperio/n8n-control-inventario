import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useFonts, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';

import ErrorBoundary from './ErrorBoundary';
import Navegacion from './Navegacion';
import { ACENTO, styles } from './tema';

export default function App() {
  // La sesion no vive aca: hay un login unico al abrir la app que vale para
  // todas las tabs, ver Navegacion.tsx y SesionContext.tsx.
  // Space Grotesk (titulos/labels/numeros) + Manrope (texto de cuerpo) --
  // ver los consts FUENTE_* en tema.tsx. Se cargan una sola vez aca arriba,
  // antes de login o captura, para que ninguna pantalla renderice con la
  // fuente del sistema y despues "salte" a la tipografia real.
  const [fuentesCargadas] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        {!fuentesCargadas ? (
          <SafeAreaView style={styles.container}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={ACENTO} />
            </View>
          </SafeAreaView>
        ) : (
          <NavigationContainer>
            <StatusBar style="light" />
            <Navegacion />
          </NavigationContainer>
        )}
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
