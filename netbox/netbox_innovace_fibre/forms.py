from django import forms

from .models import DeviceSignalRouting


class DeviceSignalRoutingForm(forms.ModelForm):
    class Meta:
        model = DeviceSignalRouting
        fields = ('from_port_name', 'from_signal', 'to_port_name', 'to_signal', 'is_bidirectional')
        widgets = {
            'from_port_name': forms.TextInput(attrs={'class': 'form-control form-control-sm', 'placeholder': 'e.g. MTP'}),
            'from_signal': forms.NumberInput(attrs={'class': 'form-control form-control-sm', 'min': 1}),
            'to_port_name': forms.TextInput(attrs={'class': 'form-control form-control-sm', 'placeholder': 'e.g. LC-1'}),
            'to_signal': forms.NumberInput(attrs={'class': 'form-control form-control-sm', 'min': 1}),
            'is_bidirectional': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }
