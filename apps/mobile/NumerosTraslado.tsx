// Numeros de un traslado en las tarjetas de las listas: la hoja del talonario
// y el numero del traslado en Syscafe, cada uno con su rotulo pequeno encima.
// Se usa en Enviados/Recibidos, Por recibir y Novedades de Supervision.

import { StyleSheet, Text, View } from 'react-native';
import { referenciaTraslado, type Traslado } from './api';
import { ACENTO, FUENTE_BODY_SEMI, FUENTE_DISPLAY_SEMI, NEUTRAL_500, NEUTRAL_700, TEXTO_PRIMARIO } from './tema';

export default function NumerosTraslado({
  traslado,
}: {
  traslado: Pick<Traslado, 'consecutivo' | 'talonario_id' | 'numero_talonario' | 'numero_syscafe'>;
}) {
  // Los traslados viejos sin hoja de talonario muestran su consecutivo (TP-000123).
  const conHoja = Boolean(traslado.talonario_id && traslado.numero_talonario);
  return (
    <View style={estilos.fila}>
      <View style={estilos.bloque}>
        <Text style={estilos.rotulo}>{conHoja ? 'Talonario' : 'Consecutivo'}</Text>
        <Text style={estilos.valor} numberOfLines={1}>
          {referenciaTraslado(traslado)}
        </Text>
      </View>
      <View style={estilos.separador} />
      <View style={estilos.bloque}>
        <Text style={estilos.rotulo}>Traslado</Text>
        {traslado.numero_syscafe ? (
          <Text style={[estilos.valor, { color: ACENTO }]} numberOfLines={1}>
            {traslado.numero_syscafe}
          </Text>
        ) : (
          <Text style={[estilos.valor, estilos.pendiente]} numberOfLines={1}>
            Pendiente
          </Text>
        )}
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  bloque: { gap: 1, flexShrink: 1 },
  rotulo: {
    color: NEUTRAL_500,
    fontSize: 10.5,
    fontFamily: FUENTE_BODY_SEMI,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  valor: { color: TEXTO_PRIMARIO, fontSize: 15, fontFamily: FUENTE_DISPLAY_SEMI, letterSpacing: 0.3 },
  pendiente: { color: NEUTRAL_500, fontStyle: 'italic', fontFamily: FUENTE_BODY_SEMI, fontSize: 14 },
  separador: { width: 1, alignSelf: 'stretch', backgroundColor: NEUTRAL_700 },
});
