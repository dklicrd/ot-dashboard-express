const PDFDocument = require('pdfkit');

function generarAvalPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `Aval de Servicio - ${data.numero_aval}`,
        Author: 'Sistema OT Dashboard',
      },
    });

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100;
    const leftMargin = 50;
    const primaryColor = '#2563eb';
    const lightGray = '#f3f4f6';
    const borderGray = '#d1d5db';

    // Header
    doc.rect(0, 0, doc.page.width, 120).fill(primaryColor);
    doc.fillColor('#ffffff')
      .fontSize(28).font('Helvetica-Bold')
      .text('AVAL DE SERVICIO', leftMargin, 30, { align: 'center' })
      .fontSize(12).font('Helvetica')
      .text('Cerraduras Electrónicas | Puertas Metálicas | Cajas de Seguridad', leftMargin, 68, { align: 'center' })
      .fontSize(10)
      .text(`Aval N°: ${data.numero_aval}`, leftMargin, 95, { align: 'center' });

    // Datos del servicio
    let y = 145;
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold')
      .text('DATOS DEL SERVICIO', leftMargin, y);
    doc.moveTo(leftMargin, y + 22).lineTo(leftMargin + pageWidth, y + 22).strokeColor(borderGray).stroke();
    y += 35;

    function drawField(label, value, x, yPos, width) {
      doc.fillColor('#6b7280').fontSize(8).font('Helvetica').text(label, x, yPos);
      doc.fillColor('#1f2937').fontSize(10).font('Helvetica').text(value || '—', x, yPos + 12, { width });
    }

    drawField('No. OT', data.numero_ot, leftMargin, y, 200);
    drawField('Fecha', data.fecha, leftMargin + 300, y, 150);
    y += 45;
    drawField('Cliente', data.cliente, leftMargin, y, 200);
    drawField('Cédula/RNC', data.cedula_rnc || '—', leftMargin + 300, y, 150);
    y += 45;
    drawField('Teléfono', data.telefono || '—', leftMargin, y, 200);
    drawField('Tipo', data.tipo_cliente || '—', leftMargin + 300, y, 150);
    y += 45;
    drawField('Dirección', data.direccion || '—', leftMargin, y, 400);

    // Descripción
    y += 50;
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold')
      .text('DESCRIPCIÓN DEL TRABAJO REALIZADO', leftMargin, y);
    doc.moveTo(leftMargin, y + 22).lineTo(leftMargin + pageWidth, y + 22).strokeColor(borderGray).stroke();
    y += 35;
    doc.fillColor('#374151').fontSize(10).font('Helvetica')
      .text(data.descripcion_trabajo || 'No especificado', leftMargin, y, { width: pageWidth });
    y += doc.y - y + 15;

    // Materiales
    if (data.materiales) {
      doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold')
        .text('MATERIALES / REPUESTOS', leftMargin, y);
      doc.moveTo(leftMargin, y + 22).lineTo(leftMargin + pageWidth, y + 22).strokeColor(borderGray).stroke();
      y += 35;
      doc.fillColor('#374151').fontSize(10).font('Helvetica')
        .text(data.materiales, leftMargin, y, { width: pageWidth });
      y += doc.y - y + 15;
    }

    // Monto
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold')
      .text('COSTO DEL SERVICIO', leftMargin, y);
    doc.moveTo(leftMargin, y + 22).lineTo(leftMargin + pageWidth, y + 22).strokeColor(borderGray).stroke();
    y += 35;
    doc.roundedRect(leftMargin, y, pageWidth, 50, 6).fill(lightGray);
    doc.fillColor('#1f2937').fontSize(11).font('Helvetica').text('Total del Servicio:', leftMargin + 15, y + 10);
    doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold')
      .text(`RD$ ${(data.costo_total || 0).toFixed(2)}`, leftMargin + pageWidth - 180, y + 8);
    y += 65;

    if (data.forma_pago) { drawField('Forma de Pago', data.forma_pago, leftMargin, y, pageWidth); y += 45; }
    if (data.garantia) { drawField('Garantía', data.garantia, leftMargin, y, pageWidth); y += 45; }
    if (data.observaciones) { drawField('Observaciones', data.observaciones, leftMargin, y, pageWidth); y += 45; }

    // Firmas
    if (y > 550) { doc.addPage(); y = 50; } else { y = Math.max(y, 500); }
    doc.moveTo(leftMargin, y).lineTo(leftMargin + pageWidth, y).strokeColor(borderGray).stroke();
    y += 20;
    doc.fillColor('#1f2937').fontSize(12).font('Helvetica-Bold')
      .text('ACEPTACIÓN DEL SERVICIO', leftMargin, y, { align: 'center' });
    y += 25;
    doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
      .text('Declaro haber recibido el servicio descrito, a mi entera satisfacción y conformidad. Autorizo el cobro del monto establecido.', leftMargin, y, { width: pageWidth, align: 'center' });
    y += 40;
    doc.moveTo(leftMargin, y + 40).lineTo(leftMargin + 200, y + 40).strokeColor('#374151').stroke();
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold').text('Firma del Cliente', leftMargin, y + 45);
    doc.fillColor('#6b7280').fontSize(8).font('Helvetica').text('Nombre:', leftMargin, y + 60);
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica').text(data.cliente, leftMargin + 40, y + 60);
    doc.moveTo(leftMargin + 300, y + 40).lineTo(leftMargin + 500, y + 40).strokeColor('#374151').stroke();
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold').text('Firma del Técnico', leftMargin + 300, y + 45);

    // Footer
    const footerY = doc.page.height - 70;
    doc.rect(0, footerY, doc.page.width, 70).fill(primaryColor);
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica')
      .text('Documento generado electrónicamente', leftMargin, footerY + 15, { align: 'center' })
      .fontSize(8).text(`Aval N° ${data.numero_aval} | OT: ${data.numero_ot}`, leftMargin, footerY + 30, { align: 'center' })
      .fontSize(7).text(`Generado el: ${new Date().toLocaleString('es-DO')}`, leftMargin, footerY + 45, { align: 'center' });

    doc.end();
  });
}

module.exports = { generarAvalPDF };
