# SIM+ Turnos Extractor 1.2

Aplicación web estática para extraer circulaciones y turnos desde libros de itinerarios, circulares PDF y capturas de pantalla. Todo se procesa en el navegador: los documentos, el JSON existente y los resultados no se envían a ningún servidor.

## Detección automática

La opción predeterminada **Automático** identifica el tipo de documento antes de extraerlo:

- las órdenes de servicio y circulares fechadas —incluidos los ejemplos de Sabadell y Vallvidrera— se procesan como servicio especial por fecha operativa;
- el libro de itinerarios BV se procesa por los bloques ordinarios `0/100`, `400/500`, `200/300` y `800/900`;
- el motor de lectura automático utiliza texto PDF cuando existe y cambia a OCR cuando el documento está escaneado.

En el libro completo de referencia se aplican directamente los bloques `5–102`, `105–158`, `161–222` y `225–294`. La aplicación determina también si el PDF usa esas páginas físicas (`desfase 0`) o si incorpora 24 páginas preliminares (`desfase 24`). No es necesario configurar los bloques. Las opciones **Circular de servicio** y **Libro de itinerarios** permanecen disponibles para forzar manualmente el formato si un documento excepcional no puede identificarse.

## Circulares de servicios especiales

El tratamiento de **Circular de servicio** admite:

- una fecha de afectación en una sola hoja;
- una fecha distribuida entre varias hojas;
- varias fechas y varias hojas dentro de la misma circular;
- varias circulares PDF seleccionadas en una misma operación;
- PDF con capa de texto y PDF escaneados.

La extracción reconoce dos estructuras habituales:

- tablas horarias con circulaciones en columnas y una fila `TORN`;
- hojas de turnos modificados, creados o adicionales, con encabezados como `Q4P14`, `Q4118` o `QRS0` y sus circulaciones debajo.

Los encabezados se normalizan sin la `Q` ni el dígito visual de servicio cuando existe: por ejemplo, `Q4P14` se guarda como `P14` y `Q4118` como `118`. Sólo se conservan circulaciones `A`, `B`, `L`, `D` o `F` seguidas de tres cifras; se omiten las que empiezan por `8` después de la letra.

La fecha se obtiene de cada apartado de la circular. En servicios nocturnos se conserva el **día operativo indicado por el documento**, aunque algunas circulaciones ocurran pasada la medianoche. La fecha manual de respaldo sólo se usa si no se puede leer ninguna fecha.

## Actualizar el JSON especial sin borrar datos

El archivo especial es anual y está indexado por fecha operativa:

```json
{
  "year": 2026,
  "date_format": "DD/MM/YYYY",
  "dates": {
    "11/09/2026": {
      "D001": "015",
      "F001": "019"
    }
  }
}
```

Flujo recomendado:

1. Selecciona una o varias circulares PDF.
2. Pulsa **Analizar documento** y revisa las asignaciones por fecha.
3. Carga el `sim_turnos_especiales.json` que ya utiliza SIM+.
4. Descarga **JSON especial actualizado**.
5. Revisa la copia descargada y súbela después a GitHub.

La aplicación conserva todas las propiedades, fechas y circulaciones anteriores, y añade las nuevas. Si una misma fecha y circulación ya existe con otro turno, permite:

- bloquear la descarga para revisarlo;
- usar la nueva extracción;
- conservar el valor del archivo actual.

El archivo cargado no se modifica. Siempre se genera una copia nueva. También se admiten JSON donde el mapa de circulaciones está envuelto en `circulations`, `circulaciones`, `trains`, `turns` o `assignments`.

El JSON especial puede contener cualquier fecha operativa modificada, aunque el servicio base de ese día sea `000`, `100`, `400`, `500`, `600` o `700`. SIM+ debe consultar primero la asignación especial de la fecha y, si no existe, aplicar su comportamiento de ausencia (`Q?`) o la regla acordada en la integración.

## Libro de itinerarios

El modo **Libro de itinerarios** mantiene la extracción de los bloques ordinarios `0/100`, `400/500`, `200/300` y `800/900`, tanto desde PDF como desde imágenes. Permite configurar el desfase de páginas y los rangos.

## Motores locales

- **Automático:** utiliza la capa de texto cuando existe y recurre a OCR en páginas escaneadas.
- **Texto PDF:** fuerza la lectura de texto y coordenadas del PDF.
- **OCR:** procesa localmente PDF escaneados, PNG, JPG y WEBP con Tesseract.js.

PDF.js, Tesseract.js, el modelo OCR y sus licencias están incluidos dentro de `vendor/`. No se usan API, analítica, almacenamiento remoto ni dependencias desde CDN.

## Publicación en GitHub Pages

1. Descomprime el ZIP y copia **todo su contenido** en la raíz del repositorio.
2. En GitHub abre **Settings → Pages**.
3. Elige **Deploy from a branch**, la rama correspondiente y la carpeta `/ (root)`.
4. Abre la URL que proporciona GitHub Pages.

No abras `index.html` directamente con `file://`, porque el navegador bloqueará los módulos. Para una prueba local, sirve la carpeta con cualquier servidor HTTP estático.

## Revisión y auditoría

La tabla permite corregir fechas, circulaciones y turnos antes de exportar. Los errores y conflictos no resueltos bloquean la descarga. La salida de auditoría conserva el documento y la página de origen, el motor usado, la confianza y las incidencias detectadas.

El OCR es una ayuda y debe revisarse cuando las capturas estén recortadas, inclinadas o borrosas. Los PDF largos pueden tardar y consumir memoria, especialmente en móviles.

## Pruebas

Las pruebas unitarias están en `tests/run-tests.mjs`. El proyecto se ha validado también con las tres estructuras de circular proporcionadas: una fecha compacta, una fecha en muchas páginas y varias fechas en varias páginas.

Consulta `THIRD_PARTY_NOTICES.md` para las versiones y licencias de las dependencias incluidas.
