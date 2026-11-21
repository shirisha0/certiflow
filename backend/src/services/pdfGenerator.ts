import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { env } from '../config/env';

export interface CertificatePdfData {
  certificateNumber: string;
  candidateName: string;
  courseName: string;
  trainingCentreName: string;
  district: string;
  issuedAt: Date;
}

export async function generateCertificatePdf(data: CertificatePdfData): Promise<string> {
  await fs.promises.mkdir(env.certStorageDir, { recursive: true });
  const filePath = path.join(env.certStorageDir, `${data.certificateNumber}.pdf`);

  const verifyUrl = `${env.publicVerifyBaseUrl}?cert=${encodeURIComponent(data.certificateNumber)}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 120, margin: 1 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 40,
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Outer border
    doc
      .lineWidth(3)
      .strokeColor('#1e3a8a')
      .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
      .stroke();

    doc
      .lineWidth(1)
      .strokeColor('#d97706')
      .rect(28, 28, doc.page.width - 56, doc.page.height - 56)
      .stroke();

    // Header
    doc
      .fontSize(14)
      .fillColor('#d97706')
      .font('Helvetica-Bold')
      .text('PRAGATI SKILLS MISSION', { align: 'center' });

    doc.moveDown(0.4);
    doc
      .fontSize(30)
      .fillColor('#1e3a8a')
      .text('CERTIFICATE OF COMPLETION', { align: 'center' });

    doc.moveDown(1.0);
    doc
      .fontSize(14)
      .fillColor('#475569')
      .font('Helvetica')
      .text('This is to certify that', { align: 'center' });

    doc.moveDown(0.5);
    doc
      .fontSize(26)
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .text(data.candidateName, { align: 'center' });

    doc.moveDown(0.6);
    doc
      .fontSize(14)
      .fillColor('#475569')
      .font('Helvetica')
      .text('has successfully completed the assessment and training requirements for', {
        align: 'center',
      });

    doc.moveDown(0.5);
    doc
      .fontSize(20)
      .fillColor('#1e3a8a')
      .font('Helvetica-Bold')
      .text(data.courseName, { align: 'center' });

    doc.moveDown(0.5);
    doc
      .fontSize(13)
      .fillColor('#334155')
      .font('Helvetica')
      .text(`Conducted at ${data.trainingCentreName}, ${data.district} District`, {
        align: 'center',
      });

    // Footer metadata & QR code
    const bottomY = doc.page.height - 150;

    doc
      .fontSize(11)
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .text(`Certificate No: ${data.certificateNumber}`, 60, bottomY);

    doc
      .font('Helvetica')
      .fillColor('#475569')
      .text(`Issued On: ${data.issuedAt.toISOString().slice(0, 10)}`, 60, bottomY + 18)
      .text('Authorized by: State Office, Pragati Skills Mission', 60, bottomY + 36);

    // QR Code on bottom right
    doc.image(qrBuffer, doc.page.width - 170, bottomY - 20, { width: 95, height: 95 });
    doc
      .fontSize(8)
      .fillColor('#64748b')
      .text('Scan to verify authenticity', doc.page.width - 185, bottomY + 80, {
        width: 125,
        align: 'center',
      });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}
