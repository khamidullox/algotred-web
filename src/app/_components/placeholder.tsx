export function Placeholder({
  title,
  step,
  children,
}: {
  title: string;
  step: string;
  children: string;
}) {
  return (
    <>
      <h1>{title}</h1>
      <p className="lead">Ещё не реализовано — {step} ТЗ.</p>
      <h2>Что здесь будет</h2>
      <div className="card">{children}</div>
    </>
  );
}
