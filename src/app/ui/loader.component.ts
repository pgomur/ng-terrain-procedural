import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'app-loader',
  templateUrl: './loader.component.html',
  styleUrl: './loader.component.scss',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoaderComponent {
  readonly status = input('');
  readonly progress = input<number | null>(null);
  readonly done = input(false);
  readonly errorTitle = input<string | null>(null);
  readonly errorMessage = input('');
}
