import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table';

import { ru } from '@/locales/ru';

type RuntimeRow = {
  component: string;
  state: string;
};

const columns: Array<ColumnDef<RuntimeRow>> = [
  {
    accessorKey: 'component',
    header: ru.status.tableComponent,
  },
  {
    accessorKey: 'state',
    header: ru.status.tableState,
  },
];

export function RuntimeTable({ state }: { state: string }) {
  const table = useReactTable({
    data: [{ component: ru.status.apiComponent, state }],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-muted text-muted-foreground">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th className="px-4 py-3 font-medium" key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr className="border-t border-border" key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td className="px-4 py-3" key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
