/**
 * Invoice PDF HTML template.
 *
 * Renders a self-contained printable HTML page for any invoice. The browser
 * displays it and the user can print → Save as PDF, which gives them native
 * browser PDF with selectable text and vector graphics.
 */

export interface InvoiceTemplateData {
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  status: string;
  subscriberName: string;
  subscriberPhone: string;
  subscriberEmail?: string;
  subscriberAddress?: string;
  packageName?: string;
  amount: number;
  tax: number;
  discount: number;
  total: number;
  paidAmount: number;
  dueAmount: number;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  payments: Array<{
    paymentNo: string;
    amount: number;
    method: string;
    paymentDate: string;
  }>;
  orgName?: string;
  orgPhone?: string;
  orgEmail?: string;
  orgAddress?: string;
  orgLogo?: string;
}

export function renderInvoiceHtml(data: InvoiceTemplateData): string {
  const statusColors: Record<string, string> = {
    PAID: 'bg-green-100 text-green-800 border-green-300',
    UNPAID: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    PARTIAL: 'bg-blue-100 text-blue-800 border-blue-300',
    OVERDUE: 'bg-red-100 text-red-800 border-red-300',
    CANCELLED: 'bg-gray-100 text-gray-800 border-gray-300',
    DRAFT: 'bg-gray-100 text-gray-800 border-gray-300',
  };

  const statusBadge =
    statusColors[data.status] || 'bg-gray-100 text-gray-800 border-gray-300';

  const itemsHtml = data.items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${item.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${item.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${item.unitPrice.toFixed(2)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${item.total.toFixed(2)}</td>
        </tr>`,
    )
    .join('');

  const paymentsHtml =
    data.payments.length > 0
      ? `
    <h3 style="font-size:14px;font-weight:600;margin:24px 0 12px;color:#374151;">Payment History</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Receipt</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Date</th>
          <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Method</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #d1d5db;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${data.payments
          .map(
            (p) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${p.paymentNo}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${p.paymentDate}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${p.method}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${p.amount.toFixed(2)}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${data.invoiceNo}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif; color: #1f2937; font-size: 13px; line-height: 1.5; }
  .page { max-width: 210mm; margin: 0 auto; padding: 20px 0; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #e5e7eb; }
  .org-info h1 { font-size: 20px; font-weight: 700; color: #111827; margin-bottom: 4px; }
  .org-info p { font-size: 12px; color: #6b7280; margin: 2px 0; }
  .invoice-title { text-align: right; }
  .invoice-title h2 { font-size: 24px; font-weight: 700; color: #111827; }
  .invoice-title .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; border: 1px solid; margin-top: 8px; }
  .badge-pill { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .${data.status === 'PAID' ? 'badge-pill' : ''} { ${data.status === 'PAID' ? 'background:#d1fae5;color:#065f46;' : ''} }
  .details { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .billing-info, .dates { background: #f9fafb; padding: 16px; border-radius: 8px; flex: 1; }
  .billing-info { margin-right: 16px; }
  .billing-info h3, .dates h3 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin-bottom: 8px; }
  .billing-info p { font-size: 14px; font-weight: 500; margin: 2px 0; }
  .billing-info .sub { font-size: 12px; color: #6b7280; font-weight: 400; }
  .dates p { font-size: 13px; margin: 4px 0; }
  .dates .label { color: #6b7280; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0; }
  thead th { padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; background: #f3f4f6; border-bottom: 2px solid #d1d5db; }
  thead th:last-child { text-align: right; }
  tbody td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
  tbody td:last-child { text-align: right; }
  .totals { margin-left: auto; width: 280px; margin-top: 8px; }
  .totals table { margin: 0; }
  .totals td { padding: 6px 12px; border-bottom: 1px solid #e5e7eb; }
  .totals td:last-child { text-align: right; font-weight: 600; }
  .totals .grand td { font-size: 16px; font-weight: 700; border-top: 2px solid #111827; border-bottom: none; padding-top: 12px; }
  .totals .due td { color: #dc2626; font-weight: 700; }
  .footer { text-align: center; padding: 24px 0 0; margin-top: 32px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="org-info">
      <h1>${data.orgName || 'ISP Management'}</h1>
      ${data.orgAddress ? `<p>${data.orgAddress}</p>` : ''}
      ${data.orgPhone ? `<p>${data.orgPhone}</p>` : ''}
      ${data.orgEmail ? `<p>${data.orgEmail}</p>` : ''}
    </div>
    <div class="invoice-title">
      <h2>INVOICE</h2>
      <div class="badge ${statusBadge}">${data.status}</div>
    </div>
  </div>

  <!-- Details -->
  <div class="details">
    <div class="billing-info">
      <h3>Bill To</h3>
      <p>${data.subscriberName}</p>
      ${data.subscriberPhone ? `<p class="sub">${data.subscriberPhone}</p>` : ''}
      ${data.subscriberEmail ? `<p class="sub">${data.subscriberEmail}</p>` : ''}
      ${data.subscriberAddress ? `<p class="sub">${data.subscriberAddress}</p>` : ''}
      ${data.packageName ? `<p class="sub" style="margin-top:8px;">Package: ${data.packageName}</p>` : ''}
    </div>
    <div class="dates">
      <h3>Dates</h3>
      <p><span class="label">Invoice Date:</span> ${data.invoiceDate}</p>
      <p><span class="label">Due Date:</span> ${data.dueDate}</p>
      <p><span class="label">Invoice #:</span> ${data.invoiceNo}</p>
    </div>
  </div>

  <!-- Items -->
  <table>
    <thead>
      <tr>
        <th style="width:50%;">Description</th>
        <th style="width:12%;text-align:center;">Qty</th>
        <th style="width:18%;text-align:right;">Unit Price</th>
        <th style="width:20%;text-align:right;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml || '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:24px;">No line items</td></tr>'}
    </tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td>${data.amount.toFixed(2)}</td></tr>
      ${data.tax > 0 ? `<tr><td>Tax</td><td>${data.tax.toFixed(2)}</td></tr>` : ''}
      ${data.discount > 0 ? `<tr><td>Discount</td><td style="color:#059669;">-${data.discount.toFixed(2)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td>${data.total.toFixed(2)}</td></tr>
      <tr class="due"><td>Due Amount</td><td>${data.dueAmount.toFixed(2)}</td></tr>
    </table>
  </div>

  <!-- Payments -->
  ${paymentsHtml}

  <!-- Footer -->
  <div class="footer">
    <p>Thank you for your business</p>
    <p>Invoice ${data.invoiceNo} — Generated on ${new Date().toLocaleDateString()}</p>
  </div>

  <!-- Print button -->
  <div class="no-print" style="text-align:center;margin-top:32px;">
    <button onclick="window.print()" style="padding:10px 28px;background:#2563eb;color:white;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Print / Save as PDF</button>
  </div>

</div>
</body>
</html>`;
}