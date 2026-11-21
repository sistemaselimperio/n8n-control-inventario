// Pantalla para las sesiones de punto: su unica funcion era Traslados, que se
// oculto en la app (ver Navegacion.tsx). En vez de dejarlas en un Inicio vacio
// se les avisa que la seccion ya no esta disponible y se les ofrece cerrar sesion.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { nombreSesion, useSesion } from './SesionContext';
import {
  ACENTO,
  FUENTE_BODY,
  FUENTE_DISPLAY,
  FUENTE_DISPLAY_SEMI,
  NEUTRAL_400,
  NEUTRAL_500,
  NEUTRAL_700,
  NEUTRAL_800,
  NEUTRAL_850,
  NEUTRAL_900,
  TEXTO_PRIMARIO,
} from './tema';

export default function PuntoNoDisponible() {
  const { sesion, cerrarSesion } = useSesion();

  return (
    <View style={estilos.contenedor}>
      <View style={estilos.tarjeta}>
        <View style={estilos.icono}>
          <Ionicons name="swap-horizontal" size={28} color={ACENTO} />
        </View>
        <Text style={estilos.mensaje}>Esta sección ya no está disponible</Text>
        <Text style={estilos.detalle}>
          Estás en la sesión de {nombreSesion(sesion)}. Los traslados entre puntos ya no se registran desde la app.
        </Text>
        <Pressable
          onPress={cerrarSesion}
          style={({ pressed }) => [estilos.boton, pressed && estilos.botonPresionado]}
        >
          <Text style={estilos.botonTexto}>Cerrar sesión</Text>
        </Pressable>
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  contenedor: {
    flex: 1,
    backgroundColor: NEUTRAL_900,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  tarjeta: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: NEUTRAL_850,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
    borderRadius: 20,
    padding: 22,
    gap: 14,
    alignItems: 'center',
  },
  icono: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(245,197,66,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mensaje: { color: TEXTO_PRIMARIO, fontSize: 19, fontFamily: FUENTE_DISPLAY, textAlign: 'center' },
  detalle: { color: NEUTRAL_400, fontSize: 13, fontFamily: FUENTE_BODY, textAlign: 'center', lineHeight: 19 },
  boton: {
    width: '100%',
    marginTop: 4,
    backgroundColor: NEUTRAL_800,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  botonPresionado: { borderColor: NEUTRAL_500 },
  botonTexto: { color: '#f87171', fontFamily: FUENTE_DISPLAY_SEMI, fontSize: 14 },
});
