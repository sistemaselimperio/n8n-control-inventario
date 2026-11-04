// Hoja modal que sube desde abajo (fondo oscuro + tarjeta pegada al borde
// inferior) -- base comun de los selectores de NuevoTraslado: destino
// (punto), fecha (SelectorFecha) y producto (ModalProducto).
// Tocar el fondo o el boton atras de Android cierra; tocar la tarjeta no
// propaga al fondo.
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { FUENTE_DISPLAY, NEUTRAL_400, NEUTRAL_700, NEUTRAL_800, NEUTRAL_850, TEXTO_PRIMARIO } from './tema';

export default function HojaModal({
  visible,
  titulo,
  onCerrar,
  children,
}: {
  visible: boolean;
  titulo: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCerrar} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Pressable style={estilos.fondo} onPress={onCerrar}>
          <Pressable style={estilos.hoja} onPress={() => {}}>
            <View style={estilos.encabezado}>
              <Text style={estilos.titulo}>{titulo}</Text>
              <Pressable onPress={onCerrar} hitSlop={10} style={estilos.botonCerrar}>
                <Ionicons name="close" size={22} color={NEUTRAL_400} />
              </Pressable>
            </View>
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const estilos = StyleSheet.create({
  fondo: { flex: 1, backgroundColor: 'rgba(4,7,12,0.72)', justifyContent: 'flex-end' },
  hoja: {
    backgroundColor: NEUTRAL_850,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: NEUTRAL_700,
    padding: 20,
    paddingBottom: 32,
    gap: 14,
    maxHeight: '88%',
  },
  encabezado: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titulo: { color: TEXTO_PRIMARIO, fontSize: 18, fontFamily: FUENTE_DISPLAY },
  botonCerrar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: NEUTRAL_800,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
