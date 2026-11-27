import { TestBed } from '@angular/core/testing';
import { LoaderComponent } from './loader.component';

describe('LoaderComponent', () => {
  const render = (inputs: Record<string, unknown>) => {
    const fixture = TestBed.createComponent(LoaderComponent);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('shows an indeterminate bar while the progress is unknown', () => {
    const element = render({ status: 'Compiling shaders' });
    expect(element.querySelector('.loader')?.getAttribute('role')).toBe('status');
    expect(element.querySelector('.loader-bar')?.classList).toContain('is-indeterminate');
    expect(element.querySelector('.loader-status')?.textContent.trim()).toBe('Compiling shaders');
    expect(element.querySelector('.loader-percent')).toBeNull();
  });

  it('shows the progress as a bar and a percentage', () => {
    const element = render({ status: 'Generating terrain', progress: 0.642 });
    const fill = element.querySelector<HTMLElement>('.loader-bar-fill');
    expect(element.querySelector('.loader-bar')?.classList).not.toContain('is-indeterminate');
    expect(fill?.style.transform).toBe('scaleX(0.642)');
    expect(element.querySelector('.loader-percent')?.textContent).toBe('64%');
  });

  it('fades out when done', () => {
    const element = render({ status: 'Generating terrain', progress: 1, done: true });
    expect(element.querySelector('.loader')?.classList).toContain('is-done');
  });

  it('shows an error as an alert without a progress bar', () => {
    const element = render({ errorTitle: 'WebGPU could not start', errorMessage: 'Use a recent browser.' });
    expect(element.querySelector('.loader')?.getAttribute('role')).toBe('alert');
    expect(element.querySelector('.loader-bar')).toBeNull();
    expect(element.querySelector('.loader-error-title')?.textContent).toBe('WebGPU could not start');
    expect(element.querySelector('.loader-error')?.textContent).toBe('Use a recent browser.');
  });
});
