# SIM+ Turnos Extractor

Aplicación web estática para convertir libros de itinerarios y capturas de tablas en JSON de circulaciones y turnos. Todo el procesamiento se realiza en el navegador: los documentos no se envían a un servidor.

## Motores incluidos

- **Texto PDF:** lee directamente la capa de texto de un PDF y conserva sus coordenadas.
- **OCR:** procesa PDF escaneado, PNG, JPG y WEBP con Tesseract.js.
- **Automático:** usa texto cuando la página lo contiene y cambia a OCR cuando está escaneada.

La extracción detecta la circulación, la fila `TORN`, los códigos de turno y las variantes por servicio. Omite circulaciones que no empiecen por `A`, `B`, `L`, `D` o `F`, así como aquellas cuya primera cifra sea `8`.

## Publicación en GitHub Pages

1. Copia **todo el contenido de esta carpeta** en la raíz de un repositorio de GitHub.
2. En el repositorio, abre **Settings → Pages**.
3. Selecciona **Deploy from a branch**, la rama correspondiente y la carpeta `/ (root)`.
4. Abre la URL que te proporcione GitHub Pages.

No abras `index.html` directamente con `file://`: los navegadores bloquean los módulos y el OCR en ese modo. También puedes probarlo con cualquier servidor HTTP estático.

## Uso

1. Adjunta un PDF o un conjunto de imágenes ordenadas.
2. Elige el motor. En la mayoría de casos, `AUTOMÁTICO` es la mejor opción.
3. Ajusta el desfase entre la página impresa y la física del PDF. El valor inicial `24` corresponde al libro usado como referencia.
4. Ajusta los bloques de páginas y servicios. Se aceptan pares como `0/100` y códigos individuales.
5. Pulsa **Analizar documento**.
6. Revisa la tabla. Las celdas son editables y el botón **VER ORIGEN** abre el fragmento correspondiente.
7. Descarga las salidas.

## Actualizar el JSON de servicios especiales

En el bloque **Actualizar servicios especiales** puedes cargar el `sim_turnos_especiales.json` que ya utilizas. Al exportar se conservarán todas sus asignaciones y se incorporarán las nuevas.

Si el mismo par servicio–circulación ya existe con un turno diferente, hay tres opciones:

- **Bloquear y revisar:** no permite descargar hasta que se elija una política o se corrijan los datos.
- **Usar la nueva extracción:** el turno revisado en la tabla sustituye al anterior.
- **Conservar el archivo actual:** se ignora el nuevo valor conflictivo; el resto de altas sí se incorpora.

El archivo original no se modifica. La aplicación descarga una copia nueva y combinada para que puedas revisarla antes de subirla a GitHub.

## Archivos generados

- `sim_turnos_servicios.json`: servicios ordinarios `0`, `100`, `200`, `300`, `400`, `500`, `800` y `900`.
- `sim_turnos_especiales.json`: servicios de tres cifras que comienzan por `6` o `7`, nuevos o combinados con un archivo existente.
- `sim_turnos_auditoria.json`: filas originales, página, motor, confianza, incidencias y datos corregidos. Está pensado para trazabilidad, no para consumo directo por SIM+.

Los turnos se guardan tal como aparecen (`001`, `S02`, `R30`), sin añadir una `Q`. Cuando no hay servicios especiales, el segundo JSON se genera igualmente con el objeto `servicios` vacío.

## Formato de integración

```json
{
  "schema_version": 1,
  "tipo": "servicios_ordinarios",
  "generado": "2026-09-04T00:00:00.000Z",
  "resumen": {
    "servicios": 2,
    "asignaciones": 3
  },
  "servicios": {
    "0": { "D001": "001", "A002": "S02" },
    "100": { "D001": "323" }
  }
}
```

SIM+ debe resolver primero el servicio del día mediante su calendario anual y después consultar `servicios[codigo][circulacion]`. El cambio operativo de día a las 03:00 debe permanecer en SIM+, no en este extractor.

## Límites y revisión

- El OCR es una ayuda, no una garantía. Revisa especialmente capturas inclinadas, borrosas o recortadas.
- Los errores y conflictos bloquean la exportación; las advertencias permiten exportar tras revisión.
- En móviles, un PDF extenso por OCR puede tardar y consumir bastante memoria. Si es posible, procesa solo los bloques necesarios.
- La aplicación no interpreta horarios ni destinos: únicamente la relación circulación–turno–servicio.

## Actualización de dependencias

Las dependencias están copiadas en `vendor/` para evitar servicios externos. Si se sustituyen, conserva sus licencias y actualiza el nombre de caché de `service-worker.js` para que los navegadores descarguen la nueva versión.

Consulta `THIRD_PARTY_NOTICES.md` para versiones y licencias.
