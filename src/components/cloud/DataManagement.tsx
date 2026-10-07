'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui';
import {
  Upload,
  Download,
  Loader2,
  Check,
  AlertCircle,
  FileArchive,
} from 'lucide-react';

interface DataManagementProps {
  /** Whether the user has an active cloud workspace */
  hasWorkspace: boolean;
}

export function DataManagement({ hasWorkspace }: DataManagementProps) {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [exportResult, setExportResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setImportResult({ success: false, message: 'Please upload a ZIP file' });
      return;
    }

    if (file.size > 100 * 1024 * 1024) {
      setImportResult({ success: false, message: 'File size exceeds 100 MB limit' });
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const res = await fetch('/api/config/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Import failed' }));
        throw new Error(data.error || `Import failed (${res.status})`);
      }

      const data = await res.json();
      setImportResult({
        success: true,
        message: data.message || `Import completed (${data.itemCount || 0} items)`,
      });
    } catch (err) {
      setImportResult({
        success: false,
        message: (err as Error).message,
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setExportResult(null);

    try {
      const res = await fetch('/api/setup/export', {
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(data.error || `Export failed (${res.status})`);
      }

      // Download the ZIP
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
        `mawadao-export-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportResult({ success: true, message: 'Export downloaded successfully' });
    } catch (err) {
      setExportResult({
        success: false,
        message: (err as Error).message,
      });
    } finally {
      setExporting(false);
    }
  };

  if (!hasWorkspace) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <FileArchive className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">Complete onboarding to enable data import/export.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Import section */}
      <div className="space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground/80">Import Data</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Upload a ZIP file from your local mawaDao Agent installation to migrate your
            configuration, agents, and conversations to the cloud.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImport(file);
          }}
        />

        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="gap-2"
        >
          {importing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              Upload ZIP
            </>
          )}
        </Button>

        {importResult && (
          <ResultMessage success={importResult.success} message={importResult.message} />
        )}
      </div>

      <div className="h-px bg-border" />

      {/* Export section */}
      <div className="space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground/80">Export Data</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Download a ZIP backup of your cloud workspace data, including configuration,
            agents, sessions, and credentials.
          </p>
        </div>

        <Button
          variant="outline"
          onClick={handleExport}
          disabled={exporting}
          className="gap-2"
        >
          {exporting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              Download Backup
            </>
          )}
        </Button>

        {exportResult && (
          <ResultMessage success={exportResult.success} message={exportResult.message} />
        )}
      </div>
    </div>
  );
}

function ResultMessage({ success, message }: { success: boolean; message: string }) {
  return (
    <div
      className={`flex items-center gap-2 p-3 rounded-md text-sm ${
        success
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
          : 'bg-destructive/10 text-destructive'
      }`}
    >
      {success ? (
        <Check className="h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="h-4 w-4 shrink-0" />
      )}
      {message}
    </div>
  );
}
