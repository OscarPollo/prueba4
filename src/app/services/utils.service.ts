import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, AlertOptions, LoadingController, ModalController, ModalOptions, ToastController, ToastOptions } from '@ionic/angular';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Observable } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { getStorage, ref, getDownloadURL } from "firebase/storage";
import { BleClient, BleDevice, ScanResult } from '@capacitor-community/bluetooth-le';

@Injectable({
  providedIn: 'root'
})
export class UtilsService {

  loadingCtrl = inject(LoadingController);
  toastCtrl = inject(ToastController);
  modalCtrl = inject(ModalController);
  router = inject(Router);
  alertCtrl = inject(AlertController);

  getOnlineStatus(): Observable<boolean> {
    return new Observable<boolean>(observer => {
      observer.next(navigator.onLine); // Emitir el estado inicial de conexión

      const onlineHandler = () => observer.next(true); // Manejador para cuando el navegador se conecta
      const offlineHandler = () => observer.next(false); // Manejador para cuando el navegador se desconecta

      window.addEventListener('online', onlineHandler);
      window.addEventListener('offline', offlineHandler);

      return () => {
        window.removeEventListener('online', onlineHandler);
        window.removeEventListener('offline', offlineHandler);
      };
    }).pipe(
      distinctUntilChanged(), // Solo emitir cuando hay un cambio en el estado de conexión
    );
  }
  async takePicture(promptLabelHeader: string) {
    const photo = await Camera.getPhoto({
      quality: 90,
      allowEditing: true,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      promptLabelHeader,
      promptLabelPhoto: 'Choose from gallery',
      promptLabelPicture: 'Take a photo'
    });
    const base64Image = photo.dataUrl;

    // Obtener el tamaño en bytes de la imagen base64
    const fileSizeInBytes = this.getBase64FileSize(base64Image);

    // Verificar si el tamaño excede el límite máximo
    if (fileSizeInBytes > 500000) {
      // Comprimir la imagen con el factor de compresión especificado
      const compressedBase64Image = await this.compressBase64Image(base64Image, 0);

      // Actualizar el tamaño de la imagen comprimida
      const compressedFileSizeInBytes = this.getBase64FileSize(compressedBase64Image);

      // Verificar nuevamente si el tamaño comprimido excede el límite máximo
      if (compressedFileSizeInBytes > 500000) {
        this.presentToast({
          message: `The captured image exceeds the maximum size allowed. Size after compressing:${compressedFileSizeInBytes}`,
          duration: 1500,
          color: 'danger',
          position: 'middle',
          icon: "checkmark-circle-outline"
        })
        throw new Error(`La imagen sigue siendo demasiado grande incluso después de la compresión. ${compressedFileSizeInBytes}`);
      }

      return compressedBase64Image; // Retornar la imagen comprimida
    } else {
      return base64Image; // Retornar la imagen original si no excede el tamaño máximo
    }
  }

  // Función para obtener el tamaño en bytes de una cadena base64
  getBase64FileSize(base64String: string) {
    // Eliminar el encabezado de la cadena base64 para obtener los datos reales de la imagen
    const base64Data = base64String.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');

    // Calcular la longitud de la cadena en bytes
    const fileSizeInBytes = base64Data.length * (3 / 4);

    return fileSizeInBytes;
  }
  // Función para comprimir una imagen base64 con un factor de compresión especificado
  compressBase64Image(base64Image: string, compressionQuality: number) {
    // Convertir la imagen base64 a un objeto Blob
    const blob = this.dataURItoBlob(base64Image);

    // Comprimir el Blob usando un elemento canvas
    return new Promise<string>((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.onload = () => {
        // Establecer el tamaño del canvas
        canvas.width = img.width;
        canvas.height = img.height;

        // Dibujar la imagen en el canvas
        ctx.drawImage(img, 0, 0, img.width, img.height);

        // Obtener la imagen comprimida como una cadena base64
        const compressedBase64Image = canvas.toDataURL('image/jpeg', compressionQuality);

        // Resolver con la imagen comprimida
        resolve(compressedBase64Image);
      };
      img.onerror = (error) => reject(error);
      img.src = URL.createObjectURL(blob);
    });
  }

  // Función para convertir una cadena base64 a un objeto Blob
  dataURItoBlob(dataURI: string) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);

    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], { type: mimeString });
  }

  //ALERT
  async presentAlert(opts?: AlertOptions) {
    const alert = await this.alertCtrl.create(opts);
    await alert.present();
  }

  //LOAGING
  loading() {
    return this.loadingCtrl.create({ spinner: "bubbles" })
  }

  //TOAST
  async presentToast(opts?: ToastOptions) {
    const toast = await this.toastCtrl.create(opts);
    toast.present();
  }
  //ENRUTA LA PAGINA DISPONIBLE
  routerLink(url: string) {
    return this.router.navigateByUrl(url);
  }

  saveInLocalStorage(key: string, value: any) {
    return localStorage.setItem(key, JSON.stringify(value))
  }

  getFromLocalStorage(key: string) {
    return JSON.parse(localStorage.getItem(key))
  }

  //MODAL
  async presentModal(opts: ModalOptions) {
    const modal = await this.modalCtrl.create(opts);
    await modal.present();

    const { data } = await modal.onWillDismiss();
    if (data) return data;
  }
  dismissModal(data?: any) {
    return this.modalCtrl.dismiss(data);
  }


  ///////////////////////////////BLUETOOTH//////////////////////////////////
  bluetoothScanResults: ScanResult[] = [];
  bluetoothIsScanning = false;
  async scanForBluetoothDevices() {
    try {
      await BleClient.initialize({ androidNeverForLocation: true });

      this.bluetoothScanResults = [];
      this.bluetoothIsScanning = true;

      // passing goProControlAndQueryServiceUUID will show only GoPro devices
      // read more here https://github.com/gopro/OpenGoPro/discussions/41#discussion-3530421
      // but if you pass empty array to services it will show all nearby bluetooth devices
      await BleClient.requestLEScan(
        { services: [] },
        this.onBluetoothDeviceFound.bind(this)
      );

      const stopScanAfterMilliSeconds = 3500;
      setTimeout(async () => {
        await BleClient.stopLEScan();
        this.bluetoothIsScanning = false;
        console.log('stopped scanning');
      }, stopScanAfterMilliSeconds);
    } catch (error) {
      this.bluetoothIsScanning = false;
      console.error('scanForBluetoothDevices', error);
    }
  }
  onBluetoothDeviceFound(result) {
    console.log('received new scan result', result);
    this.bluetoothScanResults.push(result);
  }
}