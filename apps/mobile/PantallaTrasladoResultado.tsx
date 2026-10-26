// Pantalla final del flujo de creacion -- muestra el numero visible del
// traslado (la hoja del talonario, o TP- + consecutivo) y vuelve al inicio de la tab
// (mismo criterio que PantallaResultado.tsx de Despachos, pero sin
// EstadoFinal: un traslado creado siempre es el mismo estado de exito, no
// hay equivalente a "pendiente de revision").
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { HeaderTraslado, useTraslado } from './TrasladoContext';
import { ContenidoBoton, styles, TEXTO_SOBRE_ACENTO } from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type Props = NativeStackScreenProps<TrasladosStackParamList, 'ResultadoTraslado'>;

export default function PantallaTrasladoResultado({ route }: Props) {
  const { referencia, directo } = route.params;
  const { volverAInicio } = useTraslado();

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <HeaderTraslado />

        <View style={[styles.badgeEstado, { backgroundColor: 'rgba(52,211,153,0.12)' }]}>
          <Ionicons name="checkmark-circle" size={22} color="#34d399" />
          <View style={{ flex: 1 }}>
            <Text style={[styles.badgeEstadoTitulo, { color: '#34d399' }]}>{directo ? 'Llegada registrada' : 'Traslado creado'}</Text>
            <Text style={styles.badgeEstadoMensaje}>{referencia}</Text>
          </View>
        </View>

        <View style={styles.acciones}>
          <Pressable
            style={({ pressed }) => [styles.boton, styles.botonPrimario, pressed && styles.botonPresionado]}
            onPress={volverAInicio}
          >
            <ContenidoBoton color={TEXTO_SOBRE_ACENTO} icono="home-outline" texto="Ir al inicio" />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
