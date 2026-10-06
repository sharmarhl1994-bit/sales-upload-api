import React, { useState } from 'react';

const API_BASE = 'http://localhost:4000/api';

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export default function SalesUpload() {
  const [file, setFile]       = useState(null);
  const [status, setStatus]   = useState('');
  const [loading, setLoading] = useState(false);
  const [tableData, setTableData] = useState([]);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setStatus('');
  };

  const handleUpload = async () => {
    if (!file) { setStatus('Please select an Excel file first.'); return; }

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    setStatus('Uploading...');

    try {
      const res  = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
      const json = await res.json();

      if (!res.ok) throw new Error(json.error || 'Upload failed');

      setStatus(`✅ Success – ${json.rowsRead} rows read, ${json.upserted} records upserted.`);
      fetchData();
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchData = async () => {
    try {
      const res  = await fetch(`${API_BASE}/upload/data`);
      const json = await res.json();
      setTableData(json.data || []);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  };

  const fmt = (val) =>
    val == null ? '–' : Number(val).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: '98vw' }}>
      <h2>Past Sales Upload</h2>

      {/* Upload controls */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
        <button
          onClick={handleUpload}
          disabled={loading}
          style={{ padding: '0.5rem 1.5rem', cursor: 'pointer', background: '#0070f3', color: '#fff', border: 'none', borderRadius: 4 }}
        >
          {loading ? 'Uploading…' : 'Upload Excel'}
        </button>
        <button
          onClick={fetchData}
          style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
        >
          Refresh Table
        </button>
      </div>

      {status && (
        <p style={{ color: status.startsWith('❌') ? 'red' : 'green', fontWeight: 600 }}>{status}</p>
      )}

      {/* Data table */}
      {tableData.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table border="1" cellPadding="6" style={{ borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
            <thead style={{ background: '#f0f0f0' }}>
              <tr>
                <th>Customer</th>
                <th>Fisc Var</th>
                <th>Year</th>
                {MONTHS.map(m => <th key={m} style={{ textTransform: 'uppercase' }}>{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {tableData.map((row) => (
                <tr key={row.id}>
                  <td>{row.cust_old}</td>
                  <td>{row.fiscvarnt}</td>
                  <td>{row.year}</td>
                  {MONTHS.map(m => (
                    <td key={m} style={{ textAlign: 'right' }}>{fmt(row[m])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
