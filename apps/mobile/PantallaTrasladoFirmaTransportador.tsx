// Paso 2 de crear un traslado: pantalla limpia para el conductor -- resumen
// de solo lectura (destino, productos) y un unico pad de firma. Apenas firma,
// se suben las 2 firmas (despacha, ya cargada en NuevoTraslado, y esta),
// se crea el traslado en el backend y se navega a Resultado con la
// referencia del traslado (hoja del talonario, si la tiene). Es la UNICA pantalla que de verdad envia algo al
// backend en el flujo de creacion -- NuevoTraslado solo arma el borrador.
import { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { crearTrasladoPunto, referenciaTraslado, subirFirmaTraslado } from './api';
import { mensajeError } from './errorMessages';
import CampoFirma from './CampoFirma';
import ResumenTraslado, { AvisoRol } from './ResumenTraslado';
import { HeaderTraslado, useTraslado } from './TrasladoContext';
import { ACENTO, styles } from './tema';
import type { TrasladosStackParamList } from './Navegacion';

type NavegacionFirma = NativeStackNavigationProp<TrasladosStackParamList, 'FirmaTransportador'>;

export default function PantallaTrasladoFirmaTransportador() {
  const navigation = useNavigation<NavegacionFirma>();
  const { usuario, punto, draft, cargando, setCargando, reiniciarDraft } = useTraslado();
  const [mensaje, setMensaje] = useState('');

  // firmaFirmada llega directo del onCambio de <CampoFirma> -- no alcanza
  // con guardar en un estado propio y leerlo despues: setState y esta
  // llamada pasan en el mismo evento, un estado local todavia veria el
  // closure viejo (mismo motivo que confirmar() en PantallaConfirmando.tsx).
  const confirmar = async (firmaTransportaBase64: string) => {
    if (!usuario || !draft.destino || !draft.firmaDespachaBase64) return;
    setCargando(true);
    setMensaje('Subiendo firmas...');
    try {
      const [despacha, transporta] = await Promise.all([
        subirFirmaTraslado(draft.id, 'despacha', draft.firmaDespachaBase64),
        subirFirmaTraslado(draft.id, 'transporta', firmaTransportaBase64),
      ]);

      setMensaje('Creando traslado...');
      const traslado = await crearTrasladoPunto({
        id: draft.id,
        numero_talonario: draft.numeroTalonario.trim(),
        foto_talonario_url: draft.fotoTalonarioUrl,
        punto_origen_id: usuario.punto_id,
        punto_destino_id: draft.destino.id,
        transportador_nombre: draft.transportadorNombre.trim(),
        fecha: draft.fecha,
        observaciones: draft.observaciones.trim() || undefined,
        items: draft.items.map((item) => ({
          producto: item.producto.trim(),
          marca: item.marca.trim(),
          presentacion: item.presentacion.trim(),
          cantidad: Number(item.cantidad.trim()),
          fecha_vencimiento: item.fechaVencimiento || null,
        })),
        firma_despacha_url: despacha.url,
        firma_transporta_url: transporta.url,
        creado_por: usuario.id,
      });

      reiniciarDraft();
      navigation.navigate('ResultadoTraslado', { referencia: referenciaTraslado(traslado) });
    } catch (err) {
      setMensaje(mensajeError(err, 'traslado'));
    } finally {
      setCargando(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <HeaderTraslado />

        {/* Esta pantalla se le pasa al conductor: primero le dice que hacer,
            despues le muestra que se lleva. */}
        <AvisoRol
          icono="car-outline"
          rol="Conductor"
          texto="Revisa lo que llevas y firma al final para confirmar que recibes la mercancía."
        />

        <ResumenTraslado
          origen={punto?.nombre ?? '—'}
          destino={draft.destino?.nombre ?? '—'}
          transportador={draft.transportadorNombre.trim()}
          talonario={draft.numeroTalonario.trim()}
          fecha={draft.fecha}
          items={draft.items.map((item) => ({ ...item, key: item.localId, fechaVencimiento: item.fechaVencimiento }))}
          observaciones={draft.observaciones}
        />

        <View style={styles.tarjeta}>
          <CampoFirma titulo="Firma del transportador" valor={null} onCambio={confirmar} disabled={cargando} />
        </View>

        {mensaje && !cargando ? <Text style={styles.textoErrorInline}>{mensaje}</Text> : null}
        {cargando ? (
          <View style={[styles.tarjeta, styles.estadoBox]}>
            <ActivityIndicator color={ACENTO} />
            <Text style={styles.mensajeSubiendo}>{mensaje}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
